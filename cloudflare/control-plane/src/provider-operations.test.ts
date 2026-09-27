import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDurableActionPort, reconcileActionProposal } from "./action-authority-execution";
import {
  approveAndExecuteActionApproval,
  handleRequestActionExecution,
} from "./action-authority-handlers";
import * as core from "./action-authority-core";
import { updateToolPermissionStatus } from "./tool-policy";
import {
  createAgentBehaviorSnapshotFromTemplate,
  toPackTemplate,
} from "./agent-behavior-templates";
import { manifest } from "../../../examples/complex-operator/manifest";
import { controlPlane } from "../../../examples/complex-operator/control-plane";
import type { ActionProposal } from "@operloom/agent-sdk";
import type { AgentIdentity, ControlApprovalRequestRow, D1PreparedStatement, Env } from "./types";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const identity: AgentIdentity = { scope: { userId: "u", workspaceId: "w" }, agentId: "a" };
const runtimeIdentity = {
  packId: "complex-operator",
  packVersion: manifest.version,
  runtimeVersion: controlPlane.runtimeVersion,
  bindingVersion: 1,
  runId: "origin",
  workflowIntentId: "origin-intent",
};
const proposal: ActionProposal = {
  toolId: "operator.action.execute",
  type: "allocate",
  summary: "Allocate a test resource",
  idempotencyKey: "allocate-one",
  preview: { mutation: true },
};
const fixture = async () => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec(`INSERT INTO users(id,status,created_at,updated_at) VALUES ('u','active','now','now');
    INSERT INTO workspaces(id,account_id,account_source,name,status,created_by_user_id,created_at,updated_at) VALUES ('w','acct','local','Workspace','active','u','now','now');
    INSERT INTO memberships(id,user_id,workspace_id,role,status,created_at,updated_at) VALUES ('m','u','w','owner','active','now','now');
    INSERT INTO agents(id,workspace_id,name,status,created_by_user_id,created_at,updated_at) VALUES ('a','w','Operator','active','u','now','now');
    INSERT INTO control_retention_policies(user_id,workspace_id,created_at,updated_at,confirmed_at) VALUES ('u','w','now','now','now');
    INSERT INTO control_connections(id,user_id,workspace_id,agent_id,pack_id,connection_id,provider_id,principal,credential_class,status,scopes_json,vault_object_id,vault_version,created_at,updated_at)
      VALUES ('connection','u','w','a','complex-operator','operator.external-account','test-provider','user','api_key','authorized','[]','test-vault-reference','1','now','now');`);
  db.prepare("UPDATE agents SET data_json=? WHERE id='a'").run(
    JSON.stringify({ behavior: createAgentBehaviorSnapshotFromTemplate(toPackTemplate(manifest)) }),
  );
  type Statement = D1PreparedStatement & {
    execute(): { success: true; meta: { changes: number } };
  };
  const env = {
    WORKBENCH_MUTATIONS_ENABLED: "true",
    WORKBENCH_TYPED_STATE_ENABLED: "true",
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
  await updateToolPermissionStatus(env, identity, {
    toolName: proposal.toolId,
    mutationEnabled: true,
  });
  const port = createDurableActionPort(env, identity, runtimeIdentity);
  const propose = (input = proposal) => port.propose(input);
  const request = async (input = proposal) => {
    const proposed = await propose(input);
    const response = await handleRequestActionExecution(env, identity, proposed.proposalId);
    const body = (await response.json()) as { approvalRequest?: { id: string }; code?: string };
    if (response.status !== 202) throw new Error(JSON.stringify(body));
    const approval = db
      .prepare("SELECT * FROM control_approval_requests WHERE id=?")
      .get(body.approvalRequest!.id) as unknown as ControlApprovalRequestRow;
    return { proposalId: proposed.proposalId, approval };
  };
  const dispatch = vi.spyOn(core, "dispatchAction").mockResolvedValue({
    proposalId: "test",
    status: "executed",
    summary: "Accepted",
    output: { status: "executed", idempotencyKey: proposal.idempotencyKey },
  });
  return { db, env, port, propose, request, dispatch };
};

import { createHmac, createHash } from "node:crypto";
import * as registry from "../../../lib/agent-runtime/registry";
import { createMemoryCredentialVault } from "./credential-vault";
import { dispatchProviderOperation } from "./provider-operations";
import { sweepProviderOperationPayloads } from "./provider-operation-retention";
import { providerOperationDescriptor } from "./provider-operation-registry";
import { runtimeStateCanonicalJson, createRuntimeStatePort } from "./runtime-state";
import { exportCollections, loadCollection } from "./workspace-data-export-core";
import type {
  RuntimeToolBinding,
  RuntimeStateCommit,
  RuntimeStateDefinition,
} from "@operloom/agent-sdk";

const capacityDefinitions: RuntimeStateDefinition[] = [
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
const providerFixture = async (signed = false) => {
  const f = await fixture();
  f.dispatch.mockRestore();
  Object.assign(f.env, {
    WORKBENCH_PROVIDER_OPERATIONS_ENABLED: "true",
    WORKBENCH_CONNECTIONS_ENABLED: "true",
    WORKBENCH_E2E_MODE: "true",
    WORKBENCH_VAULT_BACKEND: "memory",
    WORKBENCH_OAUTH_PROVIDERS_JSON: JSON.stringify([
      {
        id: signed ? "signed-capacity-service" : "capacity-service",
        actionUrl: "https://capacity.example/allocations",
        permittedHosts: ["capacity.example"],
      },
    ]),
  });
  const original = registry.resolvePackRuntime(runtimeIdentity.packId, runtimeIdentity.packVersion);
  if (!original.runnable) throw new Error("Fixture runtime unavailable");
  const old = original.controlPlane.tools.find((tool) => tool.id === proposal.toolId)!;
  const binding: RuntimeToolBinding = {
    ...old,
    transport: "cloudflare_inline",
    action: {
      target: "external",
      connectionId: "operator.external-account",
      proposalSchema: { type: "object" },
      resultSchema: { type: "object" },
      idempotency: "required",
      approval: "required",
      timeoutMs: 5000,
      providerOperation: {
        id: signed ? "capacity.allocate-signed" : "capacity.allocate",
        version: "1",
      },
    },
  };
  vi.spyOn(registry, "resolvePackRuntime").mockReturnValue({
    ...original,
    controlPlane: {
      ...original.controlPlane,
      state: capacityDefinitions,
      tools: original.controlPlane.tools.map((tool) => (tool.id === binding.id ? binding : tool)),
    },
  });
  const vault = await createMemoryCredentialVault().create({
    context: { workspaceId: "w" },
    name: "test-operation",
    value: JSON.stringify({ kind: "api_key", apiKey: secret, scopes: [] }),
  });
  f.db
    .prepare("UPDATE control_connections SET provider_id=?,vault_object_id=?,vault_version=?")
    .run(signed ? "signed-capacity-service" : "capacity-service", vault.id, vault.version);
  const request = (input?: Partial<ActionProposal>) =>
    f.request({ ...proposal, preview: { resource: "compute-pool", units: 2 }, ...input });
  const network = vi.fn(async (_url: string, init?: RequestInit) =>
    Response.json({
      requestId: new Headers(init?.headers).get("idempotency-key"),
      resourceId: "allocation-1",
      lifecycle: "pending",
      debugCredential: secret,
    }),
  );
  vi.stubGlobal("fetch", network);
  return { ...f, request, binding, network };
};

describe("credential-isolated provider operations", () => {
  const resources = async () => {
    const f = await providerFixture();
    const state = await createRuntimeStatePort(f.env, identity, {
      packId: runtimeIdentity.packId,
      target: "external",
      definitions: capacityDefinitions,
    });
    await state.commit({
      idempotencyKey: "seed",
      reads: [
        { namespace: "capacity", kind: "pool", key: "pool", version: 0 },
        { namespace: "capacity", kind: "pool", key: "other", version: 0 },
      ],
      writes: [
        {
          namespace: "capacity",
          kind: "pool",
          key: "pool",
          schemaVersion: 1,
          data: { remaining: 5 },
        },
        {
          namespace: "capacity",
          kind: "pool",
          key: "other",
          schemaVersion: 1,
          data: { remaining: 1 },
        },
      ],
    });
    const claim = (key = "pool", amount = 3) => ({
      namespace: "capacity",
      kind: "pool",
      key,
      version: 1,
      field: "remaining",
      amount,
    });
    const projection = (proposalId: string, remaining = 2): RuntimeStateCommit => ({
      idempotencyKey: `project:${proposalId}`,
      projection: { proposalId },
      reads: [{ namespace: "capacity", kind: "pool", key: "pool", version: 1 }],
      writes: [
        { namespace: "capacity", kind: "pool", key: "pool", schemaVersion: 1, data: { remaining } },
      ],
      entries: [{ id: `effect:${proposalId}`, type: "effect", data: { proposalId } }],
      events: [{ id: `event:${proposalId}`, type: "allocation.updated", data: { proposalId } }],
    });
    return { ...f, state, claim, projection };
  };

  it("admits only one competing capacity claim and leaves the loser undispatched", async () => {
    const f = await resources();
    const a = await f.request({ idempotencyKey: "a", reservations: [f.claim()] });
    const b = await f.request({ idempotencyKey: "b", reservations: [f.claim()] });
    const results = await Promise.all([
      approveAndExecuteActionApproval(f.env, identity, a.approval),
      approveAndExecuteActionApproval(f.env, identity, b.approval),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 502]);
    expect(f.network).toHaveBeenCalledTimes(1);
    expect(
      f.db
        .prepare("SELECT SUM(amount) n FROM control_action_reservations WHERE status='held'")
        .get()!.n,
    ).toBe(3);
    expect(f.db.prepare("SELECT COUNT(*) n FROM control_provider_operations").get()!.n).toBe(1);
    const loser = results[0]!.status === 502 ? a : b;
    expect(await reconcileActionProposal(f.env, identity, loser.proposalId)).toMatchObject({
      output: { dispatchStatus: "not_dispatched" },
    });
  });

  it("rolls back every resource and the provider receipt when one claim fails", async () => {
    const f = await resources();
    const pending = await f.request({ reservations: [f.claim(), f.claim("other", 2)] });
    expect((await approveAndExecuteActionApproval(f.env, identity, pending.approval)).status).toBe(
      502,
    );
    expect(f.db.prepare("SELECT COUNT(*) n FROM control_action_reservations").get()!.n).toBe(0);
    expect(f.db.prepare("SELECT COUNT(*) n FROM control_provider_operations").get()!.n).toBe(0);
    expect(f.network).not.toHaveBeenCalled();
  });

  it("retains ambiguous claims until a recorded provider rejection releases them", async () => {
    const f = await resources();
    f.network.mockRejectedValueOnce(new Error("lost response"));
    const pending = await f.request({ reservations: [f.claim()] });
    expect((await approveAndExecuteActionApproval(f.env, identity, pending.approval)).status).toBe(
      502,
    );
    expect(f.db.prepare("SELECT status FROM control_action_reservations").get()!.status).toBe(
      "held",
    );
    f.network.mockImplementationOnce(async (_url, init) =>
      Response.json({
        requestId: new Headers(init?.headers).get("idempotency-key"),
        resourceId: "rejected",
        lifecycle: "rejected",
      }),
    );
    await reconcileActionProposal(f.env, identity, pending.proposalId);
    expect(f.db.prepare("SELECT status FROM control_action_reservations").get()!.status).toBe(
      "released",
    );
    expect(
      (await f.state.get({ namespace: "capacity", kind: "pool", key: "pool" }))?.data.remaining,
    ).toBe(5);
    expect(f.network.mock.calls.map((call) => call[1]?.method)).toEqual(["POST", "GET"]);
  });

  it("projects once with exact debit, evidence and events, preserving holds after a late failure", async () => {
    const f = await resources();
    const pending = await f.request({ reservations: [f.claim()] });
    expect((await approveAndExecuteActionApproval(f.env, identity, pending.approval)).status).toBe(
      200,
    );
    await expect(f.state.commit(f.projection(pending.proposalId, 3))).rejects.toMatchObject({
      code: "action_projection_conflict",
    });
    f.db.exec(
      "CREATE TRIGGER projection_failure BEFORE INSERT ON control_state_entries BEGIN SELECT RAISE(ABORT,'projection_failure'); END",
    );
    await expect(f.state.commit(f.projection(pending.proposalId))).rejects.toThrow(
      "projection_failure",
    );
    expect(f.db.prepare("SELECT status FROM control_action_reservations").get()!.status).toBe(
      "held",
    );
    expect(f.db.prepare("SELECT COUNT(*) n FROM control_action_projections").get()!.n).toBe(0);
    expect(
      (await f.state.get({ namespace: "capacity", kind: "pool", key: "pool" }))?.data.remaining,
    ).toBe(5);
    f.db.exec("DROP TRIGGER projection_failure");
    const result = await f.state.commit(f.projection(pending.proposalId));
    expect(await f.state.commit(f.projection(pending.proposalId))).toEqual(result);
    await expect(
      f.state.commit({
        ...f.projection(pending.proposalId),
        idempotencyKey: "duplicate",
        reads: [{ namespace: "capacity", kind: "pool", key: "pool", version: 2 }],
      }),
    ).rejects.toMatchObject({ code: "action_projection_conflict" });
    expect(
      (await f.state.get({ namespace: "capacity", kind: "pool", key: "pool" }))?.data.remaining,
    ).toBe(2);
    expect(
      f.db.prepare("SELECT status,projection_commit_id FROM control_action_reservations").get(),
    ).toMatchObject({ status: "projected", projection_commit_id: result.id });
    expect(f.db.prepare("SELECT COUNT(*) n FROM control_state_entries").get()!.n).toBe(1);
    expect(f.db.prepare("SELECT COUNT(*) n FROM control_state_outbox").get()!.n).toBe(1);
    expect(f.network).toHaveBeenCalledTimes(1);
  });

  it("fences resource deletion, capacity underflow, schema migration and agent upgrade while held", async () => {
    const f = await resources();
    const pending = await f.request({ reservations: [f.claim()] });
    await approveAndExecuteActionApproval(f.env, identity, pending.approval);
    const ordinary = f.projection(pending.proposalId, 1);
    delete ordinary.projection;
    await expect(f.state.commit(ordinary)).rejects.toMatchObject({
      code: "action_projection_conflict",
    });
    expect(() => f.db.exec("DELETE FROM control_state_records WHERE record_key='pool'")).toThrow(
      "action_resource_conflict",
    );
    expect(() => f.db.exec("UPDATE agents SET runtime_revision=runtime_revision+1")).toThrow(
      "action_resource_upgrade_blocked",
    );
    expect(() =>
      f.db.exec(
        "INSERT INTO control_state_schema_heads(scope_id,namespace,kind,user_id,workspace_id,agent_id,schema_version,status,migration_id) SELECT scope_id,namespace,kind,user_id,workspace_id,agent_id,1,'migrating','migration' FROM control_state_records WHERE record_key='pool'",
      ),
    ).toThrow("action_resource_migration_blocked");
    f.db.exec("UPDATE control_action_proposals SET updated_at='2000-01-01T00:00:00.000Z'");
    await sweepProviderOperationPayloads(f.env);
    expect(
      f.db.prepare("SELECT result_json FROM control_provider_operations").get()!.result_json,
    ).toContain("resourceId");
  });
  it.each(["workspace", "pack", "tool", "connection", "credential", "membership"])(
    "rechecks %s authority atomically after credentials are loaded",
    async (changed) => {
      const { db, env, request, network } = await providerFixture();
      const pending = await request();
      const batch = env.DB.batch.bind(env.DB);
      let injected = false;
      env.DB.batch = async (statements) => {
        if (
          !injected &&
          db
            .prepare("SELECT status FROM control_action_proposals WHERE id=?")
            .get(pending.proposalId)!.status === "executing"
        ) {
          injected = true;
          if (changed === "credential") db.exec("UPDATE control_connections SET vault_version='2'");
          else if (changed === "membership") db.exec("UPDATE memberships SET status='revoked'");
          else {
            const id = {
              workspace: "w",
              pack: "complex-operator",
              tool: proposal.toolId,
              connection: "connection",
            }[changed];
            if (!id) throw new Error("Unknown authority fixture");
            db.prepare(
              "INSERT INTO control_kill_switches(id,user_id,workspace_id,scope_kind,scope_id,enabled,reason,created_by_user_id,created_at,updated_at) VALUES ('kill','u','w',?,?,1,'test','u','now','now')",
            ).run(changed, id);
          }
        }
        return batch(statements);
      };
      expect((await approveAndExecuteActionApproval(env, identity, pending.approval)).status).toBe(
        502,
      );
      expect(injected).toBe(true);
      expect(network).not.toHaveBeenCalled();
      expect(db.prepare("SELECT COUNT(*) n FROM control_provider_operations").get()!.n).toBe(0);
      // Recovery is observational: it may close an undispatched attempt even
      // while a kill switch is active, but still needs active membership.
      if (changed === "membership") db.exec("UPDATE memberships SET status='active'");
      expect(await reconcileActionProposal(env, identity, pending.proposalId)).toMatchObject({
        status: "reconciled",
        output: { dispatchStatus: "not_dispatched" },
      });
      expect(
        db.prepare("SELECT status FROM control_runs WHERE id=?").get(pending.approval.run_id)!
          .status,
      ).toBe("failed");
      expect((await reconcileActionProposal(env, identity, pending.proposalId)).status).toBe(
        "reconciled",
      );
      db.prepare("UPDATE control_action_proposals SET result_json=? WHERE id=?").run(
        JSON.stringify({ payloadPrunedAt: new Date().toISOString() }),
        pending.proposalId,
      );
      expect((await reconcileActionProposal(env, identity, pending.proposalId)).status).toBe(
        "reconciled",
      );
      expect(
        db
          .prepare(
            "SELECT COUNT(*) n FROM control_action_ledger WHERE transition_key='provider:not-dispatched'",
          )
          .get()!.n,
      ).toBe(1);
      expect(network).not.toHaveBeenCalled();
    },
  );

  it.each(["disabled", "unknown-operation", "arbitrary-input"])(
    "blocks %s before approval admission",
    async (changed) => {
      const { env, request, propose, binding, network, db } = await providerFixture();
      if (changed === "disabled") env.WORKBENCH_PROVIDER_OPERATIONS_ENABLED = "false";
      if (changed === "unknown-operation")
        binding.action!.providerOperation!.id = "unknown.operation";
      if (changed === "arbitrary-input") {
        const proposed = await propose({
          ...proposal,
          preview: { resource: "compute-pool", units: 2, url: "https://other.example" },
        });
        expect(
          (await handleRequestActionExecution(env, identity, proposed.proposalId)).status,
        ).toBe(403);
      } else await expect(request()).rejects.toThrow();
      expect(network).not.toHaveBeenCalled();
      expect(db.prepare("SELECT COUNT(*) n FROM control_action_reviews").get()!.n).toBe(0);
    },
  );

  it.each([false, true])(
    "dispatches once with broker-owned authentication (signed=%s)",
    async (signed) => {
      const { db, env, request, network } = await providerFixture(signed);
      const pending = await request();
      const response = await approveAndExecuteActionApproval(env, identity, pending.approval);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        result: { status: "executed", output: { lifecycle: "pending" } },
      });
      expect(JSON.stringify(body)).not.toContain(secret);
      expect(network).toHaveBeenCalledTimes(1);
      const [url, init] = network.mock.calls[0]!;
      expect(url).toBe("https://capacity.example/allocations");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      const headers = new Headers(init?.headers);
      if (signed) {
        expect(headers.has("authorization")).toBe(false);
        const canonical = [
          "POST",
          url,
          createHash("sha256").update(String(init?.body)).digest("hex"),
          headers.get("idempotency-key"),
          headers.get("x-capacity-timestamp"),
        ].join("\n");
        expect(headers.get("x-capacity-signature")).toBe(
          createHmac("sha256", secret).update(canonical).digest("hex"),
        );
      } else expect(headers.get("authorization")).toBe(`Bearer ${secret}`);
      const receipt = db.prepare("SELECT * FROM control_provider_operations").get()!;
      expect(receipt.status).toBe("succeeded");
      expect(JSON.stringify(receipt)).not.toContain(secret);
      expect(() => db.exec("UPDATE control_provider_operations SET result_json='{}'")).toThrow(
        "provider_operation_immutable",
      );
    },
  );

  it("reconciles a lost response with GET and never sends a second mutation", async () => {
    const { db, env, request, network } = await providerFixture();
    network.mockRejectedValueOnce(new Error(`lost response ${secret}`));
    const pending = await request();
    const response = await approveAndExecuteActionApproval(env, identity, pending.approval);
    expect(response.status).toBe(502);
    expect(db.prepare("SELECT status FROM control_provider_operations").get()!.status).toBe(
      "outcome_unknown",
    );
    const result = await reconcileActionProposal(env, identity, pending.proposalId);
    expect(result.status).toBe("reconciled");
    expect(network.mock.calls.map((call) => call[1]?.method)).toEqual(["POST", "GET"]);
    expect(network.mock.calls[1]![0]).toMatch(
      /^https:\/\/capacity\.example\/allocations\/[a-f0-9]{64}$/,
    );
  });

  it("repairs projection from the durable outcome without contacting the provider", async () => {
    const { db, env, request, network } = await providerFixture();
    const pending = await request();
    db.exec(
      "CREATE TRIGGER test_projection_failure BEFORE UPDATE ON control_action_proposals WHEN NEW.status='executed' BEGIN SELECT RAISE(ABORT,'test_projection_failure'); END",
    );
    expect((await approveAndExecuteActionApproval(env, identity, pending.approval)).status).toBe(
      409,
    );
    expect(db.prepare("SELECT status FROM control_provider_operations").get()!.status).toBe(
      "succeeded",
    );
    db.exec("DROP TRIGGER test_projection_failure");
    expect((await reconcileActionProposal(env, identity, pending.proposalId)).status).toBe(
      "reconciled",
    );
    expect(network).toHaveBeenCalledTimes(1);
    expect(
      db.prepare("SELECT status FROM control_runs WHERE id=?").get(pending.approval.run_id)!.status,
    ).toBe("completed");
    expect((await reconcileActionProposal(env, identity, pending.proposalId)).status).toBe(
      "reconciled",
    );
    expect(network).toHaveBeenCalledTimes(1);
    db.exec("UPDATE memberships SET role='member'");
    await expect(reconcileActionProposal(env, identity, pending.proposalId)).rejects.toThrow(
      "provider_operation_not_found",
    );
  });

  it("exports redacted outcomes and prunes resolved payloads without losing identities", async () => {
    const { db, env, request, network } = await providerFixture();
    const pending = await request();
    expect((await approveAndExecuteActionApproval(env, identity, pending.approval)).status).toBe(
      200,
    );
    const collection = exportCollections.find(
      (item) => item.name === "control_provider_operations",
    )!;
    const exported = await loadCollection(env, identity, collection);
    expect(JSON.stringify(exported)).not.toContain(secret);
    expect(JSON.stringify(exported)).not.toContain("vault_version");
    const before = db.prepare("SELECT id,request_hash FROM control_provider_operations").get()!;
    await sweepProviderOperationPayloads(env);
    expect(
      db.prepare("SELECT result_json FROM control_provider_operations").get()!.result_json,
    ).toContain("resourceId");
    db.exec("UPDATE control_action_proposals SET updated_at='2000-01-01T00:00:00.000Z'");
    await sweepProviderOperationPayloads(env);
    expect(db.prepare("SELECT id,request_hash FROM control_provider_operations").get()).toEqual(
      before,
    );
    expect(
      db.prepare("SELECT result_json FROM control_provider_operations").get()!.result_json,
    ).toContain("payloadPrunedAt");
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("returns uncertainty during concurrent dispatch without issuing another request", async () => {
    const { env, request, binding, network } = await providerFixture();
    let release!: (response: Response) => void;
    let called!: () => void;
    const started = new Promise<void>((resolve) => {
      called = resolve;
    });
    network.mockImplementationOnce(async () => {
      called();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const pending = await request();
    const first = approveAndExecuteActionApproval(env, identity, pending.approval);
    await started;
    const duplicate = await dispatchProviderOperation(env, identity, pending.proposalId, binding);
    expect(duplicate.status).toBe("outcome_unknown");
    const id = new Headers(network.mock.calls[0]![1]?.headers).get("idempotency-key");
    release(Response.json({ requestId: id, resourceId: "allocation-1", lifecycle: "active" }));
    expect((await first).status).toBe(200);
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("fences an in-flight pre-admission continuation before declaring no dispatch", async () => {
    const { env, db, request, network } = await providerFixture();
    const pending = await request();
    const batch = env.DB.batch.bind(env.DB);
    let release!: () => void;
    let paused!: () => void;
    let intercepted = false;
    const reached = new Promise<void>((resolve) => {
      paused = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    env.DB.batch = async (statements) => {
      if (
        !intercepted &&
        db
          .prepare("SELECT status FROM control_action_proposals WHERE id=?")
          .get(pending.proposalId)!.status === "executing"
      ) {
        intercepted = true;
        paused();
        await resume;
      }
      return batch(statements);
    };
    const executing = approveAndExecuteActionApproval(env, identity, pending.approval);
    await reached;
    expect(await reconcileActionProposal(env, identity, pending.proposalId)).toMatchObject({
      status: "reconciled",
      output: { dispatchStatus: "not_dispatched" },
    });
    release();
    expect(await (await executing).json()).toMatchObject({
      result: { status: "reconciled", output: { dispatchStatus: "not_dispatched" } },
    });
    expect(network).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) n FROM control_provider_operations").get()!.n).toBe(0);
  });

  it("preserves a competing dispatch receipt instead of declaring no effect", async () => {
    const { env, db, request, network, binding } = await providerFixture();
    const pending = await request();
    vi.spyOn(core, "dispatchAction").mockRejectedValueOnce(
      new Error("Interrupted before broker admission"),
    );
    expect((await approveAndExecuteActionApproval(env, identity, pending.approval)).status).toBe(
      502,
    );
    const batch = env.DB.batch.bind(env.DB);
    let injected = false;
    env.DB.batch = async (statements) => {
      if (!injected) {
        injected = true;
        const operation = providerOperationDescriptor(env, binding)!;
        db.prepare(`INSERT INTO control_provider_operations
          (id,user_id,workspace_id,agent_id,proposal_id,review_id,operation_id,operation_version,descriptor_json,request_hash,connection_record_id,vault_version,status,created_at,updated_at)
          VALUES (?,'u','w','a',?,?,?,?,?,'hash','connection','1','dispatching','now','now')`).run(
          "b".repeat(64),
          pending.proposalId,
          pending.approval.id,
          operation.id,
          operation.version,
          runtimeStateCanonicalJson(operation),
        );
      }
      return batch(statements);
    };
    expect(await reconcileActionProposal(env, identity, pending.proposalId)).toMatchObject({
      status: "reconciled",
      output: { resourceId: "allocation-1" },
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM control_action_ledger WHERE transition_key='provider:not-dispatched'",
        )
        .get()!.n,
    ).toBe(0);
    expect(network.mock.calls.map((call) => call[1]?.method)).toEqual(["GET"]);
  });

  it.each(["secret", "redirect", "oversize", "wrong-identity"])(
    "retains %s responses as unknown",
    async (scenario) => {
      const { env, request, network, db } = await providerFixture();
      network.mockImplementationOnce(async (_url, init) => {
        const id = new Headers(init?.headers).get("idempotency-key");
        if (scenario === "redirect")
          return new Response(null, {
            status: 302,
            headers: { location: "https://other.example" },
          });
        if (scenario === "oversize")
          return new Response(" ".repeat(65537), {
            headers: { "content-type": "application/json" },
          });
        return Response.json({
          requestId: scenario === "wrong-identity" ? "a".repeat(64) : id,
          resourceId: scenario === "secret" ? secret : "allocation-1",
          lifecycle: "active",
        });
      });
      const pending = await request();
      expect((await approveAndExecuteActionApproval(env, identity, pending.approval)).status).toBe(
        502,
      );
      expect(
        db.prepare("SELECT status,result_json FROM control_provider_operations").get(),
      ).toMatchObject({ status: "outcome_unknown", result_json: "{}" });
    },
  );

  it("rejects changed configuration before approval and cross-tenant receipt access", async () => {
    const { env, request, network, binding } = await providerFixture();
    const pending = await request();
    env.WORKBENCH_OAUTH_PROVIDERS_JSON = JSON.stringify([
      {
        id: "capacity-service",
        actionUrl: "https://other.example/allocations",
        permittedHosts: ["other.example"],
      },
    ]);
    expect((await approveAndExecuteActionApproval(env, identity, pending.approval)).status).toBe(
      409,
    );
    await expect(
      dispatchProviderOperation(
        env,
        { ...identity, scope: { ...identity.scope, workspaceId: "other" } },
        pending.proposalId,
        binding,
      ),
    ).rejects.toThrow("provider_action_not_executing");
    expect(network).not.toHaveBeenCalled();
  });
});
