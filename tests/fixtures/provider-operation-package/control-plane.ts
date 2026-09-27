import { defineControlPlaneModule } from "@operloom/agent-sdk/control-plane";

const proposalSchema = {
  type: "object",
  required: ["resource", "units"],
  additionalProperties: false,
  properties: {
    resource: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$" },
    units: { type: "integer", minimum: 1, maximum: 1000000 },
  },
};
export const controlPlane = defineControlPlaneModule({
  packId: "provider-operation-fixture",
  runtimeVersion: "1.0.0",
  compatiblePackVersions: "^1.0.0",
  requirements: {
    minimumBackendVersion: "2.0.0",
    capabilities: ["workflow.request", "state.atomic"],
  },
  state: [
    {
      namespace: "capacity",
      kind: "pool",
      schemaVersion: 1,
      schema: {
        type: "object",
        properties: { remaining: { type: "integer", minimum: 0 } },
        required: ["remaining"],
        additionalProperties: false,
      },
    },
  ],
  tools: [
    { id: "capacity.allocate", connectionId: "capacity.service" },
    { id: "capacity.allocate-signed", connectionId: "capacity.signed-service" },
  ].map(({ id, connectionId }) => ({
    id,
    description: "Allocate capacity through a reviewed provider operation.",
    inputSchema: proposalSchema,
    outputSchema: { type: "object" },
    executionModes: ["dry_run", "execute"] as const,
    transport: "cloudflare_inline" as const,
    adapterVersion: "capacity-v1",
    timeoutMs: 6000,
    maxArtifactBytes: 1024,
    policy: {
      reference: "capacity-v1",
      adminVisible: true,
      modelVisible: false,
      requiresApproval: true,
      policyEditable: true,
      mutationRisk: "mutation_capable" as const,
    },
    action: {
      target: "external" as const,
      connectionId,
      proposalSchema,
      resultSchema: { type: "object", required: ["requestId", "resourceId", "lifecycle"] },
      idempotency: "required" as const,
      approval: "required" as const,
      timeoutMs: 5000,
      providerOperation: { id, version: "1" },
    },
  })),
  workflows: [
    {
      type: "capacity.request",
      stateTarget: "external",
      label: "Propose allocation",
      description: "Propose capacity with an explicit operator review.",
      inputSchema: {
        type: "object",
        required: ["resource", "units", "key", "signed"],
        additionalProperties: false,
        properties: {
          ...proposalSchema.properties,
          key: { type: "string", minLength: 1, maxLength: 100 },
          signed: { type: "boolean" },
          reserve: { type: "boolean", default: false },
        },
      },
      outputSchema: { type: "object", required: ["proposalId"] },
      conformanceInput: { resource: "fixture-pool", units: 1, key: "fixture", signed: false },
      form: [],
      // This workflow records intent; execution tools are invoked only after review.
      toolIds: [],
      cancellation: { adapter: "none", physicalAbort: "unsupported" },
      async execute(input, context) {
        const record = input.reserve
          ? await context.state!.get({ namespace: "capacity", kind: "pool", key: "pool" })
          : null;
        if (input.reserve && !record) throw new Error("Capacity pool has not been initialized");
        const result = await context.actions.propose({
          toolId: input.signed ? "capacity.allocate-signed" : "capacity.allocate",
          type: "allocate_capacity",
          summary: `Allocate ${input.resource}`,
          idempotencyKey: String(input.key),
          preview: { resource: input.resource, units: input.units },
          ...(record
            ? {
                reservations: [
                  {
                    namespace: record.namespace,
                    kind: record.kind,
                    key: record.key,
                    version: record.version,
                    field: "remaining",
                    amount: Number(input.units),
                  },
                ],
              }
            : {}),
        });
        return { ok: true, summary: "Allocation proposed for review.", output: result };
      },
    },
    {
      type: "capacity.seed",
      stateTarget: "external",
      label: "Initialize capacity",
      description: "Initialize a canonical external capacity record.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object" },
      form: [],
      toolIds: [],
      cancellation: { adapter: "none", physicalAbort: "unsupported" },
      async execute(_input, context) {
        const state = context.state!;
        const record = await state.get({ namespace: "capacity", kind: "pool", key: "pool" });
        if (!record)
          await state.commit({
            idempotencyKey: "initial-capacity",
            reads: [{ namespace: "capacity", kind: "pool", key: "pool", version: 0 }],
            writes: [
              {
                namespace: "capacity",
                kind: "pool",
                key: "pool",
                schemaVersion: 1,
                data: { remaining: 5 },
              },
            ],
          });
        return { ok: true, summary: "Capacity initialized.", output: {} };
      },
    },
    {
      type: "capacity.project",
      stateTarget: "external",
      label: "Project allocation",
      description: "Project a recorded provider result without submitting an allocation.",
      inputSchema: {
        type: "object",
        properties: { proposalId: { type: "string", minLength: 1 } },
        required: ["proposalId"],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
      conformanceInput: { proposalId: "fixture-proposal" },
      form: [],
      toolIds: [],
      cancellation: { adapter: "none", physicalAbort: "unsupported" },
      async execute(input, context) {
        const proposalId = String(input.proposalId);
        const inspected = await context.actions.inspect!(proposalId);
        if (inspected.projection)
          return {
            ok: true,
            summary: "Projection already recorded.",
            output: inspected.projection,
          };
        if (inspected.provider?.status !== "succeeded" || !inspected.proposal)
          throw new Error("Provider result is not available for projection");
        const amount = inspected.proposal.reservations?.[0]?.amount;
        if (!amount) throw new Error("This allocation has no capacity reservation");
        const state = context.state!;
        const record = await state.get({ namespace: "capacity", kind: "pool", key: "pool" });
        if (!record) throw new Error("Capacity record is unavailable");
        const receipt = await state.commit({
          idempotencyKey: `allocation:${proposalId}`,
          projection: { proposalId },
          reads: [record],
          writes: [
            {
              namespace: record.namespace,
              kind: record.kind,
              key: record.key,
              schemaVersion: 1,
              data: { remaining: Number(record.data.remaining) - amount },
            },
          ],
          entries: [
            {
              id: `allocation:${proposalId}`,
              type: "effect",
              data: { proposalId, provider: inspected.provider.output },
            },
          ],
          events: [
            { id: `allocation:${proposalId}`, type: "allocation.updated", data: { proposalId } },
          ],
        });
        return { ok: true, summary: "Allocation projected.", output: { commitId: receipt.id } };
      },
    },
  ],
  health: [],
  evals: [],
});
