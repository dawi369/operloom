import {
  defineControlPlaneModule,
  monitorCursorState,
  monitorFingerprint,
  observeMonitor,
  requireRuntimeState,
  type AgentExecutionContext,
  type ControlPlaneRuntimeModule,
  type RuntimeRecord,
  type RuntimeResult,
  type RuntimeStatePort,
  type RuntimeStateRecord,
} from "@operloom/agent-sdk/control-plane";

const namespace = "capacity";
const identifier = { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$" } as const;
const poolKey = (pool: string) => ({ namespace, kind: "pool", key: pool });
const proposalSchema = {
  type: "object",
  required: ["resource", "units"],
  additionalProperties: false,
  properties: { resource: identifier, units: { type: "integer", minimum: 1, maximum: 1000000 } },
};
const decisionSchema = {
  type: "object",
  required: ["allocate", "rationale"],
  additionalProperties: false,
  properties: {
    // The local model fixture uses this default; providers decide from the evidence.
    allocate: { type: "boolean", default: true },
    rationale: { type: "string", minLength: 1, maxLength: 1000 },
  },
};

type Feed = { pool: string; demand: number };
type Cycle = {
  outcome: string;
  pool: string;
  demand: number;
  allocated: number;
  settled: string[];
};

const done = (output: Cycle & RuntimeRecord, summary: string): RuntimeResult => ({
  ok: true,
  output,
  summary,
});

/**
 * Projects each approved allocation exactly once: the ledger entry, the pool's derived
 * availability and the request status commit together under the action's projection identity.
 */
const settle = async (state: RuntimeStatePort, context: AgentExecutionContext) => {
  const open = await state.list({
    namespace,
    kind: "request",
    index: { name: "status", value: "proposed" },
    limit: 20,
  });
  const settled: string[] = [];
  for (const request of open.records) {
    const proposalId = String(request.data.proposalId);
    const inspected = await context.actions.inspect!(proposalId);
    const status = inspected.provider?.status;
    if (inspected.projection || (status !== "succeeded" && status !== "failed")) continue;
    const pool = await state.get(poolKey(String(request.data.pool)));
    if (!pool) continue;
    const succeeded = status === "succeeded";
    const units = succeeded ? Number(request.data.units) : 0;
    const resourceId = succeeded ? String(inspected.provider!.output.resourceId) : null;
    await state.commit({
      idempotencyKey: `settle-${proposalId}`,
      // A failed dispatch released its reservation, so only successes carry a projection.
      ...(succeeded ? { projection: { proposalId } } : {}),
      reads: [pool, request],
      writes: [
        ...(succeeded
          ? [
              {
                ...poolKey(pool.key),
                schemaVersion: 1,
                data: { ...pool.data, available: Number(pool.data.available) - units },
              },
            ]
          : []),
        {
          namespace,
          kind: "request",
          key: request.key,
          schemaVersion: 1,
          data: {
            ...request.data,
            status: succeeded ? "allocated" : "rejected",
            ...(resourceId ? { resourceId } : {}),
          },
        },
      ],
      entries: [
        {
          id: `ledger-${proposalId}`,
          type: "effect",
          data: {
            proposalId,
            pool: pool.key,
            units,
            outcome: succeeded ? "allocated" : "rejected",
            resourceId,
          },
        },
      ],
      events: [
        {
          id: `allocation-${proposalId}`,
          type: "allocation.settled",
          data: {
            proposalId,
            pool: pool.key,
            units,
            outcome: succeeded ? "allocated" : "rejected",
          },
        },
      ],
    });
    settled.push(proposalId);
  }
  return settled;
};

const ensurePool = async (state: RuntimeStatePort, pool: string, capacity: number) => {
  const existing = await state.get(poolKey(pool));
  if (existing) return existing;
  await state.commit({
    idempotencyKey: `pool-${pool}`,
    reads: [{ ...poolKey(pool), version: 0 }],
    writes: [{ ...poolKey(pool), schemaVersion: 1, data: { capacity, available: capacity } }],
  });
  return (await state.get(poolKey(pool)))!;
};

/** One monitor tick: settle, observe, then no-op, hold or propose an allocation for review. */
const runCycle = async (
  input: RuntimeRecord,
  context: AgentExecutionContext,
): Promise<RuntimeResult> => {
  const state = requireRuntimeState(context);
  const evidence = context.context;
  if (!evidence || !context.models)
    throw new Error("Scoped context and structured models are required");
  evidence.assertReady();
  const feed = evidence.snapshot.sources.find((source) => source.id === "feed")?.data as
    | Feed
    | undefined;
  if (!feed) throw new Error("The capacity feed is unavailable");
  const settings = context.settings.values;
  const settled = await settle(state, context);
  const pool: RuntimeStateRecord = await ensurePool(
    state,
    feed.pool,
    Number(settings.poolCapacity),
  );
  const available = Number(pool.data.available);
  const allocated = Number(pool.data.capacity) - available;
  const base = { pool: feed.pool, demand: feed.demand, allocated, settled };

  const observation = await observeMonitor(state, {
    namespace,
    key: feed.pool,
    fingerprint: await monitorFingerprint({ pool: feed.pool, demand: feed.demand, allocated }),
    observedAt: new Date().toISOString(),
  });
  if (!observation.changed)
    return done({ ...base, outcome: "no_change" }, "Capacity is unchanged since the last tick.");

  const unmet = feed.demand - allocated;
  const units = Math.min(unmet, Number(settings.maxUnitsPerAllocation), available);
  const record = (
    outcome: string,
    data: RuntimeRecord,
    created: Parameters<RuntimeStatePort["commit"]>[0]["writes"] = [],
  ) =>
    state.commit({
      idempotencyKey: `${context.run.id}.decision`,
      reads: [
        ...observation.commit.reads,
        pool,
        ...created.map(({ namespace, kind, key }) => ({ namespace, kind, key, version: 0 })),
      ],
      writes: [...observation.commit.writes, ...created],
      entries: [
        {
          id: `${context.run.id}.decision`,
          type: "decision",
          data: {
            outcome,
            ...base,
            unmet,
            snapshotId: evidence.snapshot.id,
            settingsVersion: context.settings.version,
            ...data,
          },
        },
      ],
    });

  if (unmet < Number(settings.escalateAbove)) {
    await record("noop", { explanation: "Unmet demand is below the escalation threshold." });
    return done({ ...base, outcome: "noop" }, "Demand is within tolerance.");
  }
  if (units < 1) {
    await record("exhausted", { explanation: "The pool has no available capacity." });
    return done({ ...base, outcome: "exhausted" }, "The pool is exhausted.");
  }
  const decision = await context.models.structured({
    idempotencyKey: "allocation-decision",
    prompt: `${String(settings.policy)}\n\nPool ${feed.pool}: demand ${feed.demand}, allocated ${allocated}, available ${available}. The bounded allocation is ${units} units. Decide whether to allocate it and explain why in one or two sentences.`,
    maxOutputTokens: 300,
    outputSchema: decisionSchema,
  });
  const rationale = String(decision.output.rationale);
  if (decision.output.allocate !== true) {
    await record("hold", { units, rationale, reservationId: decision.reservationId });
    return done({ ...base, outcome: "hold" }, "The model held the allocation.");
  }
  const proposal = await context.actions.propose({
    toolId: "resource-allocator.allocate",
    type: "capacity.allocate",
    summary: `Allocate ${units} units to ${feed.pool}`,
    idempotencyKey: `${context.run.trigger?.dispatchId ?? context.run.id}.allocate`,
    preview: { resource: feed.pool, units },
    reservations: [
      { ...poolKey(feed.pool), version: pool.version, field: "available", amount: units },
    ],
  });
  await record(
    "escalate",
    { units, rationale, proposalId: proposal.proposalId, reservationId: decision.reservationId },
    [
      {
        namespace,
        kind: "request",
        key: proposal.proposalId,
        schemaVersion: 1,
        data: {
          pool: feed.pool,
          units,
          status: "proposed",
          proposalId: proposal.proposalId,
          rationale,
        },
      },
    ],
  );
  return done(
    { ...base, outcome: "escalated", proposalId: proposal.proposalId },
    `Proposed ${units} units for review.`,
  );
};

export const controlPlane: ControlPlaneRuntimeModule = defineControlPlaneModule<
  Omit<ControlPlaneRuntimeModule, "apiVersion" | "kind">
>({
  packId: "resource-allocator",
  runtimeVersion: "1.0.0",
  compatiblePackVersions: "^1.0.0",
  requirements: {
    minimumBackendVersion: "2.0.0",
    capabilities: [
      "workflow.request",
      "context.snapshots",
      "state.atomic",
      "models.structured",
      "usage.reservations",
    ],
  },
  settings: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        policy: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
          description: "Allocation policy the model applies when demand escalates.",
        },
        poolCapacity: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          description: "Capacity of a newly observed pool.",
        },
        maxUnitsPerAllocation: { type: "integer", minimum: 1, maximum: 100 },
        escalateAbove: {
          type: "integer",
          minimum: 0,
          maximum: 100,
          description: "Unmet demand, in units, that escalates a tick.",
        },
      },
    },
    defaults: {
      policy:
        "Allocate only what current unmet demand requires. Hold when the demand looks transient.",
      poolCapacity: 20,
      maxUnitsPerAllocation: 5,
      escalateAbove: 2,
    },
    editable: ["policy", "poolCapacity", "maxUnitsPerAllocation", "escalateAbove"],
  },
  tools: [
    {
      id: "resource-allocator.allocate",
      description: "Allocate capacity through the reviewed capacity provider operation.",
      inputSchema: proposalSchema,
      outputSchema: { type: "object" },
      executionModes: ["dry_run", "execute"],
      transport: "cloudflare_inline",
      adapterVersion: "allocate-v1",
      timeoutMs: 6000,
      maxArtifactBytes: 1024,
      policy: {
        reference: "resource-allocator.allocate.v1",
        adminVisible: true,
        modelVisible: false,
        requiresApproval: true,
        policyEditable: true,
        mutationRisk: "mutation_capable",
      },
      action: {
        connectionId: "capacity.service",
        proposalSchema,
        resultSchema: { type: "object", required: ["requestId", "resourceId", "lifecycle"] },
        idempotency: "required",
        approval: "required",
        timeoutMs: 5000,
        providerOperation: { id: "capacity.allocate", version: "1" },
        simulate: async (proposal) => ({
          requestId: await monitorFingerprint(proposal.idempotencyKey),
          resourceId: `sim-${String(proposal.preview.resource)}-${String(proposal.preview.units)}`,
          lifecycle: "active",
        }),
      },
    },
  ],
  health: [],
  evals: [],
  context: [
    {
      id: "capacity.feed",
      version: "1",
      maxAgeMs: 60000,
      timeoutMs: 100,
      schema: {
        type: "object",
        required: ["pool", "demand"],
        additionalProperties: false,
        properties: { pool: identifier, demand: { type: "integer", minimum: 0, maximum: 1000 } },
      },
      // A mock feed: explicit demand wins; otherwise demand cycles with the wall-clock minute.
      resolve({ input, scope }) {
        const pool = typeof input.pool === "string" ? input.pool : "primary";
        const demand =
          typeof input.demand === "number"
            ? input.demand
            : 4 + (new Date().getUTCMinutes() % 4) * 3;
        return {
          status: "available",
          data: { pool, demand },
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          provenance: [{ reference: `mock-feed:${scope.agentId}:${pool}`, version: "1" }],
        };
      },
    },
  ],
  state: [
    {
      namespace,
      kind: "pool",
      schemaVersion: 1,
      schema: {
        type: "object",
        required: ["capacity", "available"],
        additionalProperties: false,
        properties: {
          capacity: { type: "integer", minimum: 1 },
          available: { type: "integer", minimum: 0 },
        },
      },
    },
    {
      namespace,
      kind: "request",
      schemaVersion: 1,
      indexes: [{ name: "status", field: "status" }],
      schema: {
        type: "object",
        required: ["pool", "units", "status", "proposalId", "rationale"],
        additionalProperties: false,
        properties: {
          pool: identifier,
          units: { type: "integer", minimum: 1 },
          status: { type: "string", enum: ["proposed", "allocated", "rejected"] },
          proposalId: { type: "string", minLength: 1, maxLength: 200 },
          rationale: { type: "string", maxLength: 1000 },
          resourceId: { type: "string", maxLength: 200 },
        },
      },
    },
    monitorCursorState(namespace),
  ],
  queries: [
    {
      id: "resource-allocator.overview",
      description: "Pools, open requests and settled allocations in the current effect target.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: {
        type: "object",
        required: ["pools", "requests"],
        properties: {
          pools: { type: "array", maxItems: 20 },
          requests: { type: "array", maxItems: 50 },
        },
      },
      async execute(_input, context) {
        const [pools, requests] = await Promise.all([
          context.state!.list({ namespace, kind: "pool", limit: 20 }),
          context.state!.list({ namespace, kind: "request", limit: 50 }),
        ]);
        return {
          pools: pools.records.map((record) => ({ pool: record.key, ...record.data })),
          requests: requests.records.map((record) => ({ id: record.key, ...record.data })),
        };
      },
    },
  ],
  workflows: [
    {
      type: "resource-allocator.cycle",
      label: "Run allocation cycle",
      description:
        "Settle approved allocations, observe the capacity feed, then no-op, hold or propose an allocation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { pool: identifier, demand: { type: "integer", minimum: 0, maximum: 1000 } },
      },
      outputSchema: {
        type: "object",
        required: ["outcome", "pool", "demand", "allocated", "settled"],
      },
      conformanceInput: { pool: "conformance", demand: 1 },
      form: [
        { name: "pool", label: "Pool", description: "Capacity pool", kind: "text" },
        {
          name: "demand",
          label: "Demand",
          description: "Override the mock feed's demand",
          kind: "number",
          min: 0,
          max: 1000,
        },
      ],
      // Allocation executes only after operator review, never inside the cycle.
      toolIds: [],
      cancellation: { adapter: "none", physicalAbort: "unsupported" },
      execute: runCycle,
    },
  ],
});
