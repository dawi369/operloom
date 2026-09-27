import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ActionProposal,
  RuntimeStateCommit,
  RuntimeStateDefinition,
  RuntimeToolBinding,
} from "@operloom/agent-sdk";
import { createDurableActionPort, reconcileActionProposal } from "./action-authority-execution";
import {
  approveAndExecuteActionApproval,
  handleRequestActionExecution,
} from "./action-authority-handlers";
import { updateToolPermissionStatus } from "./tool-policy";
import {
  createAgentBehaviorSnapshotFromTemplate,
  toPackTemplate,
} from "./agent-behavior-templates";
import { createMemoryCredentialVault } from "./credential-vault";
import { createRuntimeStatePort } from "./runtime-state";
import * as vault from "./credential-vault";
import * as runner from "./tool-runner";
import * as broker from "./connection-broker";
import * as registry from "../../../lib/agent-runtime/registry";
import { manifest } from "../../../examples/complex-operator/manifest";
import { controlPlane } from "../../../examples/complex-operator/control-plane";
import type {
  AgentIdentity,
  ControlApprovalRequestRow,
  D1PreparedStatement,
  EffectTarget,
  Env,
} from "./types";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const toolId = "operator.action.execute";
const runtimeIdentity = {
  packId: "complex-operator",
  packVersion: manifest.version,
  runtimeVersion: controlPlane.runtimeVersion,
  bindingVersion: 1,
  runId: "origin",
  workflowIntentId: "origin-intent",
};
const capacity: RuntimeStateDefinition[] = [
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
];
const secret = "synthetic-capacity-key-local-only-12345";
const allocation = (idempotencyKey: string, input: Partial<ActionProposal> = {}) =>
  ({
    toolId,
    type: "allocate",
    summary: "Allocate capacity",
    idempotencyKey,
    preview: { resource: "compute-pool", units: 3 },
    ...input,
  }) satisfies ActionProposal;

/** The same package binding under either effect target; only the agent's target differs. */
const providerBinding = (simulate = true): RuntimeToolBinding => {
  const original = controlPlane.tools.find((tool) => tool.id === toolId)!;
  return {
    ...original,
    transport: "cloudflare_inline",
    sandbox: undefined,
    action: {
      connectionId: "operator.external-account",
      proposalSchema: { type: "object" },
      resultSchema: { type: "object", required: ["requestId", "resourceId", "lifecycle"] },
      idempotency: "required",
      approval: "required",
      timeoutMs: 5000,
      providerOperation: { id: "capacity.allocate", version: "1" },
      ...(simulate
        ? {
            simulate: (proposal: ActionProposal) => ({
              requestId: `simulation:${proposal.idempotencyKey}`,
              resourceId: `sim-${proposal.idempotencyKey}`,
              lifecycle: "pending",
            }),
          }
        : {}),
    },
  };
};

const useBinding = (binding: RuntimeToolBinding) => {
  const original = registry.resolvePackRuntime(runtimeIdentity.packId, runtimeIdentity.packVersion);
  if (!original.runnable) throw new Error("Fixture runtime unavailable");
  vi.spyOn(registry, "resolvePackRuntime").mockReturnValue({
    ...original,
    controlPlane: {
      ...original.controlPlane,
      state: capacity,
      tools: original.controlPlane.tools.map((tool) => (tool.id === toolId ? binding : tool)),
    },
  });
};

const fixture = async (target: EffectTarget, options: { mutationsEnabled?: boolean } = {}) => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec(`INSERT INTO users(id,status,created_at,updated_at) VALUES ('u','active','now','now');
    INSERT INTO workspaces(id,account_id,account_source,name,status,created_by_user_id,created_at,updated_at) VALUES ('w','acct','local','Workspace','active','u','now','now');
    INSERT INTO memberships(id,user_id,workspace_id,role,status,created_at,updated_at) VALUES ('m','u','w','owner','active','now','now');
    INSERT INTO control_retention_policies(user_id,workspace_id,created_at,updated_at,confirmed_at) VALUES ('u','w','now','now','now');`);
  db.prepare(
    "INSERT INTO agents(id,workspace_id,name,status,effect_target,created_by_user_id,created_at,updated_at,data_json) VALUES ('a','w','Operator','active',?,'u','now','now',?)",
  ).run(
    target,
    JSON.stringify({ behavior: createAgentBehaviorSnapshotFromTemplate(toPackTemplate(manifest)) }),
  );
  type Statement = D1PreparedStatement & {
    execute(): { success: true; meta: { changes: number } };
  };
  const env = {
    ...(options.mutationsEnabled === false ? {} : { OPERLOOM_MUTATIONS_ENABLED: "true" }),
    DB: {
      prepare(sql: string): Statement {
        let values: unknown[] = [];
        const statement: Statement = {
          bind(...args) {
            if (args.length !== (sql.match(/\?/g)?.length ?? 0)) throw new Error("Bind mismatch");
            values = args;
            return statement;
          },
          async first<T>() {
            return (db.prepare(sql).get(...(values as never[])) ?? null) as T | null;
          },
          async all<T>() {
            return { results: db.prepare(sql).all(...(values as never[])) as T[] };
          },
          async run() {
            return statement.execute();
          },
          execute() {
            const before = Number(db.prepare("SELECT total_changes() n").get()!.n);
            db.prepare(sql).run(...(values as never[]));
            return {
              success: true,
              meta: { changes: Number(db.prepare("SELECT total_changes() n").get()!.n) - before },
            };
          },
        };
        return statement;
      },
      async batch(statements: Statement[]) {
        db.exec("BEGIN");
        try {
          const result = statements.map((item) => item.execute());
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
  } as unknown as Env;
  const identity: AgentIdentity = {
    scope: { userId: "u", workspaceId: "w" },
    agentId: "a",
    effectTarget: target,
  };
  await updateToolPermissionStatus(env, identity, { toolName: toolId, mutationEnabled: true });
  const port = createDurableActionPort(env, identity, runtimeIdentity);
  const request = async (proposal: ActionProposal) => {
    const { proposalId } = await port.propose(proposal);
    const response = await handleRequestActionExecution(env, identity, proposalId);
    const body = (await response.json()) as { approvalRequest?: { id: string }; code?: string };
    if (response.status !== 202) return { proposalId, status: response.status, body };
    const approval = db
      .prepare("SELECT * FROM control_approval_requests WHERE id=?")
      .get(body.approvalRequest!.id) as unknown as ControlApprovalRequestRow;
    return { proposalId, status: response.status, body, approval };
  };
  const execute = async (proposal: ActionProposal) => {
    const requested = await request(proposal);
    if (!requested.approval) throw new Error(JSON.stringify(requested.body));
    const response = await approveAndExecuteActionApproval(env, identity, requested.approval);
    return {
      ...requested,
      status: response.status,
      body: (await response.json()) as {
        code?: string;
        result?: Record<string, unknown> & { output?: Record<string, unknown> };
      },
    };
  };
  const state = (scope: EffectTarget) =>
    createRuntimeStatePort(env, identity, {
      packId: runtimeIdentity.packId,
      target: scope,
      definitions: capacity,
    });
  const network = vi.fn(async (_url: string, init?: RequestInit) =>
    Response.json({
      requestId: new Headers(init?.headers).get("idempotency-key"),
      resourceId: "allocation-1",
      lifecycle: "pending",
    }),
  );
  vi.stubGlobal("fetch", network);
  const isolation = {
    vault: vi.spyOn(vault, "resolveCredentialVault"),
    runner: vi.spyOn(runner, "invokeFlyToolRunner"),
    capability: vi.spyOn(broker, "issueFlyConnectionCapability"),
  };
  return { db, env, identity, port, request, execute, state, network, isolation };
};

type Fixture = Awaited<ReturnType<typeof fixture>>;
const connectExternalProvider = async (f: Fixture) => {
  Object.assign(f.env, {
    OPERLOOM_CONNECTIONS_ENABLED: "true",
    OPERLOOM_E2E_MODE: "true",
    OPERLOOM_VAULT_BACKEND: "memory",
    OPERLOOM_OAUTH_PROVIDERS_JSON: JSON.stringify([
      {
        id: "capacity-service",
        actionUrl: "https://capacity.example/allocations",
        permittedHosts: ["capacity.example"],
      },
    ]),
  });
  const stored = await createMemoryCredentialVault().create({
    context: { workspaceId: "w" },
    name: "test-operation",
    value: JSON.stringify({ kind: "api_key", apiKey: secret, scopes: [] }),
  });
  f.db
    .prepare(`INSERT INTO control_connections(id,user_id,workspace_id,agent_id,pack_id,connection_id,provider_id,principal,credential_class,status,scopes_json,vault_object_id,vault_version,created_at,updated_at)
      VALUES ('connection','u','w','a','complex-operator','operator.external-account','capacity-service','user','api_key','authorized','[]',?,?,'now','now')`)
    .run(stored.id, stored.version);
};
const expectIsolated = (f: Fixture) => {
  expect(f.network).not.toHaveBeenCalled();
  expect(f.isolation.vault).not.toHaveBeenCalled();
  expect(f.isolation.runner).not.toHaveBeenCalled();
  expect(f.isolation.capability).not.toHaveBeenCalled();
};
const seedPools = async (f: Fixture) => {
  for (const scope of ["simulation", "external"] as const)
    await (
      await f.state(scope)
    ).commit({
      idempotencyKey: `seed-${scope}`,
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
};
const projection = (proposalId: string, remaining: number): RuntimeStateCommit => ({
  idempotencyKey: `project-${proposalId}`,
  projection: { proposalId },
  reads: [{ namespace: "capacity", kind: "pool", key: "pool", version: 1 }],
  writes: [
    { namespace: "capacity", kind: "pool", key: "pool", schemaVersion: 1, data: { remaining } },
  ],
  entries: [{ id: `effect-${proposalId}`, type: "effect", data: { proposalId } }],
});

describe("one action path under both effect targets", () => {
  it("returns the same result shape for the same package action", async () => {
    useBinding(providerBinding());
    const external = await fixture("external");
    await connectExternalProvider(external);
    const real = await external.execute(allocation("same-shape"));
    const simulation = await fixture("simulation");
    const simulated = await simulation.execute(allocation("same-shape"));
    expect(real.status).toBe(200);
    expect(simulated.status).toBe(200);
    expect(external.network).toHaveBeenCalledTimes(1);
    expect(Object.keys(simulated.body.result!).sort()).toEqual(
      Object.keys(real.body.result!).sort(),
    );
    expect(Object.keys(simulated.body.result!.output!).sort()).toEqual(
      Object.keys(real.body.result!.output!).sort(),
    );
    expect(simulated.body.result).toMatchObject({
      status: real.body.result!.status,
      summary: real.body.result!.summary,
      externalReference: "sim-same-shape",
      output: { resourceId: "sim-same-shape", lifecycle: "pending" },
    });
    for (const f of [external, simulation])
      expect(f.db.prepare("SELECT effect_target FROM control_action_proposals").get()).toEqual({
        effect_target: f.identity.effectTarget,
      });
    expect(simulation.db.prepare("SELECT COUNT(*) n FROM control_action_reviews").get()!.n).toBe(1);
  });

  it("never uses the network, vault, broker or runner and needs no connection", async () => {
    const f = await fixture("simulation");
    // The unmodified package binding runs on a signed runner when the agent is external.
    const result = await f.execute(allocation("runner-one", { preview: { mutation: true } }));
    expect(result.status).toBe(200);
    expect(result.body.result).toMatchObject({
      status: "executed",
      externalReference: "simulation:runner-one",
      output: { status: "executed", idempotencyKey: "runner-one" },
    });
    expect(f.db.prepare("SELECT COUNT(*) n FROM control_connections").get()!.n).toBe(0);
    expect(f.db.prepare("SELECT connection_record_id FROM control_action_proposals").get()).toEqual(
      { connection_record_id: null },
    );
    expectIsolated(f);
  });

  it("writes a simulation receipt and projects only simulation-scope state", async () => {
    useBinding(providerBinding());
    const f = await fixture("simulation");
    await seedPools(f);
    const claim = {
      namespace: "capacity",
      kind: "pool",
      key: "pool",
      version: 1,
      field: "remaining",
      amount: 3,
    };
    const executed = await f.execute(allocation("reserved", { reservations: [claim] }));
    expect(executed.status).toBe(200);
    expect(f.db.prepare("SELECT * FROM control_provider_operations").get()).toMatchObject({
      effect_target: "simulation",
      status: "succeeded",
      connection_record_id: "simulation",
      vault_version: "simulation",
      result_json: JSON.stringify({
        lifecycle: "pending",
        requestId: "simulation:reserved",
        resourceId: "sim-reserved",
      }),
    });
    expect(f.db.prepare("SELECT status FROM control_action_reservations").get()!.status).toBe(
      "held",
    );
    expect(await f.port.inspect!(executed.proposalId)).toMatchObject({
      provider: { status: "succeeded", output: { resourceId: "sim-reserved" } },
      projection: null,
    });
    const external = await f.state("external");
    await expect(external.commit(projection(executed.proposalId, 2))).rejects.toMatchObject({
      code: "action_projection_conflict",
    });
    const simulation = await f.state("simulation");
    const receipt = await simulation.commit(projection(executed.proposalId, 2));
    expect(await f.port.inspect!(executed.proposalId)).toMatchObject({
      projection: { commitId: receipt.id },
    });
    const pool = { namespace: "capacity", kind: "pool", key: "pool" };
    expect((await simulation.get(pool))?.data.remaining).toBe(2);
    expect(await external.get(pool)).toMatchObject({ version: 1, data: { remaining: 5 } });
    expect(f.db.prepare("SELECT status FROM control_action_reservations").get()!.status).toBe(
      "projected",
    );
    expectIsolated(f);
  });

  it("reconciles a simulated receipt to its recorded outcome without dispatch", async () => {
    useBinding(providerBinding());
    const f = await fixture("simulation");
    const pending = await f.request(allocation("repair"));
    f.db.exec(
      "CREATE TRIGGER publication_failure BEFORE UPDATE ON control_action_proposals WHEN NEW.status='executed' BEGIN SELECT RAISE(ABORT,'publication_failure'); END",
    );
    expect(
      (await approveAndExecuteActionApproval(f.env, f.identity, pending.approval!)).status,
    ).toBe(409);
    f.db.exec("DROP TRIGGER publication_failure");
    expect(await reconcileActionProposal(f.env, f.identity, pending.proposalId)).toMatchObject({
      status: "reconciled",
      output: { resourceId: "sim-repair" },
    });
    expect(
      f.db.prepare("SELECT status FROM control_runs WHERE id=?").get(pending.approval!.run_id)!
        .status,
    ).toBe("completed");
    expect(f.db.prepare("SELECT COUNT(*) n FROM control_provider_operations").get()!.n).toBe(1);
    expectIsolated(f);
  });

  it("fails without side effects when the binding has no simulator", async () => {
    useBinding(providerBinding(false));
    const f = await fixture("simulation");
    const result = await f.execute(allocation("no-simulator"));
    expect(result.status).toBe(502);
    expect(result.body.result).toMatchObject({
      status: "failed",
      summary: "This action has no simulator; switch the agent to external to run it.",
    });
    expect(
      JSON.parse(
        String(f.db.prepare("SELECT error_json FROM control_action_proposals").get()!.error_json),
      ),
    ).toMatchObject({ code: "simulation_unavailable" });
    expect(f.db.prepare("SELECT COUNT(*) n FROM control_provider_operations").get()!.n).toBe(0);
    expect(f.db.prepare("SELECT COUNT(*) n FROM control_action_reservations").get()!.n).toBe(0);
    expectIsolated(f);
  });

  it("applies kill switches to simulated execution", async () => {
    useBinding(providerBinding());
    const f = await fixture("simulation");
    const pending = await f.request(allocation("killed"));
    f.db
      .exec(`INSERT INTO control_kill_switches(id,user_id,workspace_id,scope_kind,scope_id,enabled,reason,created_by_user_id,created_at,updated_at)
      VALUES ('kill','u','w','tool','${toolId}',1,'test','u','now','now')`);
    const response = await approveAndExecuteActionApproval(f.env, f.identity, pending.approval!);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "kill_switch_active" });
    expect(f.db.prepare("SELECT status FROM control_action_proposals").get()!.status).toBe(
      "approval_requested",
    );
    expect(f.db.prepare("SELECT COUNT(*) n FROM control_provider_operations").get()!.n).toBe(0);
    expectIsolated(f);
  });

  it("allows simulation while the external mutation posture is disabled", async () => {
    useBinding(providerBinding());
    const external = await fixture("external", { mutationsEnabled: false });
    await connectExternalProvider(external);
    const blocked = await external.request(allocation("posture"));
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ code: "mutation_disabled" });
    const simulation = await fixture("simulation", { mutationsEnabled: false });
    const simulated = await simulation.execute(allocation("posture"));
    expect(simulated.status).toBe(200);
    expect(simulated.body.result).toMatchObject({ status: "executed" });
    expectIsolated(simulation);
  });
});
