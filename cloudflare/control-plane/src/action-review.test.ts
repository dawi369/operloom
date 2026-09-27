import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDurableActionPort, executeActionProposal } from "./action-authority-execution";
import {
  approveAndExecuteActionApproval,
  handleRequestActionExecution,
} from "./action-authority-handlers";
import * as core from "./action-authority-core";
import { expireActionReviews } from "./action-review-expiry";
import { handleDenyToolApproval } from "./tool-approvals";
import { sweepExpiredOperationalData } from "./artifact-lifecycle";
import { updateToolPermissionStatus } from "./tool-policy";
import {
  createAgentBehaviorSnapshotFromTemplate,
  toPackTemplate,
} from "./agent-behavior-templates";
import { manifest } from "../../../examples/complex-operator/manifest";
import { controlPlane } from "../../../examples/complex-operator/control-plane";
import { exportCollections, loadCollection } from "./workspace-data-export-core";
import { runtimeStateScopeId } from "./runtime-state";
import type { ActionProposal } from "@operloom/agent-sdk";
import type { AgentIdentity, ControlApprovalRequestRow, D1PreparedStatement, Env } from "./types";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
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
const count = (db: DatabaseSync, table: string) =>
  Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n);

describe("bound external action reviews", () => {
  it.each(["lost-response", "invalid-result", "unrecognized-status"])(
    "retains %s after dispatch as unknown without leaking adapter errors or redispatching",
    async (scenario) => {
      const { db, env, request, dispatch } = await fixture();
      const pending = await request();
      if (scenario === "lost-response") {
        dispatch.mockRejectedValue(new Error("socket closed: private-credential-test-value"));
      } else {
        dispatch.mockResolvedValue({
          proposalId: pending.proposalId,
          status: scenario === "invalid-result" ? "executed" : ("invalid" as "executed"),
          summary: "private-credential-test-value",
          output: {},
        });
      }
      const response = await approveAndExecuteActionApproval(env, identity, pending.approval);
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ result: { status: "outcome_unknown" } });
      const row = db
        .prepare("SELECT * FROM control_action_proposals WHERE id=?")
        .get(pending.proposalId)!;
      expect(row.status).toBe("outcome_unknown");
      expect(row.terminal_at).toBeNull();
      expect(JSON.stringify(row)).not.toContain("private-credential-test-value");
      await expect(executeActionProposal(env, identity, pending.proposalId)).rejects.toThrow();
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(
        db
          .prepare("SELECT COUNT(*) n FROM control_action_ledger WHERE status='outcome_unknown'")
          .get()!.n,
      ).toBe(1);
    },
  );

  it("preserves explicit unknown and failed outcomes without requiring a success payload", async () => {
    const { db, env, request, dispatch } = await fixture();
    for (const status of ["outcome_unknown", "failed"] as const) {
      const pending = await request({ ...proposal, idempotencyKey: status });
      dispatch.mockResolvedValue({
        proposalId: pending.proposalId,
        status,
        summary: "Provider outcome",
      });
      const response = await approveAndExecuteActionApproval(env, identity, pending.approval);
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ result: { status } });
      expect(
        db
          .prepare("SELECT status FROM control_action_proposals WHERE id=?")
          .get(pending.proposalId)!.status,
      ).toBe(status);
    }
  });

  it("prunes terminal payloads at retention while preserving hashes and unresolved evidence", async () => {
    const { db, env, request } = await fixture();
    const completed = await request();
    expect((await approveAndExecuteActionApproval(env, identity, completed.approval)).status).toBe(
      200,
    );
    const pending = await request({ ...proposal, idempotencyKey: "pending" });
    db.exec("UPDATE control_action_proposals SET updated_at='2000-01-01T00:00:00.000Z'");
    expect(() => db.exec("UPDATE control_action_reviews SET binding_json='{}'")).toThrow(
      "action_review_immutable",
    );
    expect(() => db.exec("UPDATE control_action_proposals SET proposal_json='{}'")).toThrow(
      "action_proposal_payload_immutable",
    );
    const before = db
      .prepare("SELECT request_hash FROM control_action_reviews WHERE id=?")
      .get(completed.approval.id)!;
    await sweepExpiredOperationalData(env);
    const after = db
      .prepare("SELECT request_hash,binding_json FROM control_action_reviews WHERE id=?")
      .get(completed.approval.id)!;
    expect(after.request_hash).toBe(before.request_hash);
    expect(JSON.parse(String(after.binding_json))).toEqual({ payloadPrunedAt: expect.any(String) });
    expect(
      JSON.parse(
        String(
          db
            .prepare("SELECT proposal_json FROM control_action_proposals WHERE id=?")
            .get(completed.proposalId)!.proposal_json,
        ),
      ),
    ).toEqual({ payloadPrunedAt: expect.any(String) });
    expect(
      JSON.parse(
        String(
          db
            .prepare("SELECT binding_json FROM control_action_reviews WHERE id=?")
            .get(pending.approval.id)!.binding_json,
        ),
      ),
    ).toMatchObject({ proposalJson: expect.any(String) });
  });
  it("preserves review content while recording an operator denial", async () => {
    const { db, env, request, dispatch } = await fixture();
    const { approval } = await request();
    const response = await handleDenyToolApproval(
      new Request("https://local/deny", {
        method: "POST",
        body: JSON.stringify({ reason: "Capacity required elsewhere" }),
      }),
      env,
      identity,
      approval.id,
    );
    expect(response.status).toBe(200);
    const updated = db
      .prepare("SELECT status,data_json FROM control_approval_requests WHERE id=?")
      .get(approval.id)!;
    expect(updated.status).toBe("denied");
    expect(JSON.parse(String(updated.data_json))).toMatchObject({
      ...JSON.parse(approval.data_json),
      denyReason: "Capacity required elsewhere",
    });
    expect(db.prepare("SELECT status FROM control_action_proposals").get()!.status).toBe(
      "cancelled",
    );
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("preserves exact proposal replay and rejects changed content or cross-agent lookup", async () => {
    const { db, env, propose } = await fixture();
    expect(await propose()).toEqual(await propose());
    for (const input of [
      { ...proposal, summary: "Changed" },
      { ...proposal, preview: { mutation: true, amount: 2 } },
      { ...proposal, preconditions: [] },
    ])
      await expect(propose(input)).rejects.toMatchObject({ code: "idempotency_conflict" });
    const other = createDurableActionPort(
      env,
      { ...identity, agentId: "another" },
      runtimeIdentity,
    );
    await expect(other.propose(proposal)).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(count(db, "control_action_proposals")).toBe(1);
  });

  it("binds one concurrent request to one approval, run and immutable review", async () => {
    const { db, env, propose } = await fixture();
    const { proposalId } = await propose();
    const responses = await Promise.all([
      handleRequestActionExecution(env, identity, proposalId),
      handleRequestActionExecution(env, identity, proposalId),
    ]);
    expect(responses.map((item) => item.status).sort()).toEqual([202, 409]);
    for (const table of [
      "control_action_reviews",
      "control_runs",
      "control_workflow_intents",
      "control_approval_requests",
    ])
      expect(count(db, table)).toBe(1);
    expect(() => db.exec("UPDATE control_action_proposals SET proposal_json='{}'")).toThrow(
      "action_proposal_payload_immutable",
    );
    expect(() => db.exec("UPDATE control_action_reviews SET request_hash='changed'")).toThrow(
      "action_review_immutable",
    );
    expect(() => db.exec("UPDATE control_approval_requests SET data_json='{}'")).toThrow(
      "action_approval_payload_immutable",
    );
  });

  it("admits one external dispatch for concurrent approval and exports redacted review evidence", async () => {
    const { db, env, request, dispatch } = await fixture();
    const { approval } = await request();
    const responses = await Promise.all([
      approveAndExecuteActionApproval(env, identity, approval),
      approveAndExecuteActionApproval(env, identity, approval),
    ]);
    expect(responses.map((item) => item.status).sort()).toEqual([200, 409]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT status FROM control_action_proposals").get()!.status).toBe(
      "executed",
    );
    const exported = await loadCollection(
      env,
      identity,
      exportCollections.find((item) => item.name === "control_action_reviews")!,
    );
    expect(exported).toHaveLength(1);
    expect(JSON.stringify(exported)).not.toContain("test-vault-reference");
  });

  it.each(["role", "policy", "connection", "credential", "kill", "agent"])(
    "rejects %s changes after review without dispatch",
    async (change) => {
      const { db, env, request, dispatch } = await fixture();
      const { approval } = await request();
      if (change === "role") db.exec("UPDATE memberships SET role='viewer'");
      if (change === "policy")
        db.exec("UPDATE tool_permissions SET data_json=json_set(data_json,'$.mutationEnabled',0)");
      if (change === "connection") db.exec("UPDATE control_connections SET status='revoked'");
      if (change === "credential") db.exec("UPDATE control_connections SET vault_version='2'");
      if (change === "kill")
        db.exec(
          "INSERT INTO control_kill_switches(id,user_id,workspace_id,scope_kind,scope_id,enabled,reason,created_by_user_id,created_at,updated_at) VALUES ('kill','u','w','tool','operator.action.execute',1,'stop','u','now','now')",
        );
      if (change === "agent")
        db.exec("UPDATE agents SET data_json=json_set(data_json,'$.custom.changed',1)");
      const response = await approveAndExecuteActionApproval(env, identity, approval);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(dispatch).not.toHaveBeenCalled();
      expect(db.prepare("SELECT status FROM control_approval_requests").get()!.status).toBe(
        "requested",
      );
    },
  );

  it("rejects revocation inside the approval transaction and rolls back dependent transitions", async () => {
    const { db, env, request, dispatch } = await fixture();
    const { approval } = await request();
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce((statements) => {
      db.exec("UPDATE memberships SET status='inactive'");
      return batch(statements);
    });
    const response = await approveAndExecuteActionApproval(env, identity, approval);
    expect(response.status).toBe(409);
    expect(db.prepare("SELECT status FROM control_runs").get()!.status).toBe("interrupted");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("expires unconsumed approvals without affecting accepted external work", async () => {
    const { db, env, request, dispatch } = await fixture();
    const { approval, proposalId } = await request();
    const future = new Date(Date.now() + 16 * 60_000).toISOString();
    db.function("strftime", { varargs: true }, () => future);
    const rejected = await approveAndExecuteActionApproval(env, identity, approval);
    expect(rejected.status).toBe(409);
    expect(await expireActionReviews(env)).toEqual({ selected: 1 });
    expect(await expireActionReviews(env)).toEqual({ selected: 0 });
    expect(
      db.prepare("SELECT status FROM control_action_proposals WHERE id=?").get(proposalId)!.status,
    ).toBe("expired");
    expect(db.prepare("SELECT status FROM control_runs").get()!.status).toBe("cancelled");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("checks declared external-state versions in the transition transaction", async () => {
    const { db, env, request, dispatch } = await fixture();
    const original = core.resolveBinding;
    vi.spyOn(core, "resolveBinding").mockImplementation((row) => {
      const resolved = original(row);
      return {
        ...resolved,
        runtime: {
          ...resolved.runtime,
          controlPlane: {
            ...resolved.runtime.controlPlane,
            state: [
              { namespace: "capacity", kind: "pool", schemaVersion: 1, schema: { type: "object" } },
            ],
          },
        },
      };
    });
    const key = { namespace: "capacity", kind: "pool", key: "main", version: 0 };
    const { approval } = await request({ ...proposal, preconditions: [key] });
    const scope = await runtimeStateScopeId(identity, "complex-operator", "external");
    db.prepare(`INSERT INTO control_state_records(id,user_id,workspace_id,agent_id,scope_id,namespace,kind,record_key,schema_version,version,data_json,updated_at)
      VALUES ('state','u','w','a',?,'capacity','pool','main',1,1,'{}','now')`).run(scope);
    expect((await approveAndExecuteActionApproval(env, identity, approval)).status).toBe(409);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("fails closed for historical approved rows without a review", async () => {
    const { db, env, propose, dispatch } = await fixture();
    const { proposalId } = await propose();
    db.exec("UPDATE control_action_proposals SET status='approved'");
    await expect(executeActionProposal(env, identity, proposalId)).rejects.toMatchObject({
      code: "action_review_required",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rechecks authority in dispatch admission after approval commits", async () => {
    const { db, env, request, dispatch } = await fixture();
    const { approval } = await request();
    const batch = env.DB.batch.bind(env.DB);
    let calls = 0;
    vi.spyOn(env.DB, "batch").mockImplementation((statements) => {
      if (++calls === 2)
        db.exec("UPDATE control_connections SET vault_version='changed-after-approval'");
      return batch(statements);
    });
    expect((await approveAndExecuteActionApproval(env, identity, approval)).status).toBe(409);
    expect(db.prepare("SELECT status FROM control_action_proposals").get()!.status).toBe(
      "approved",
    );
    expect(dispatch).not.toHaveBeenCalled();
    db.function("strftime", { varargs: true }, () =>
      new Date(Date.now() + 16 * 60_000).toISOString(),
    );
    expect(await expireActionReviews(env)).toEqual({ selected: 1 });
    expect(db.prepare("SELECT status FROM control_runs").get()!.status).toBe("cancelled");
  });

  it("rejects changed adapters and leaves already accepted actions untouched by expiry", async () => {
    const { db, env, request, dispatch } = await fixture();
    const first = await request();
    const original = core.resolveBinding;
    const changed = vi.spyOn(core, "resolveBinding").mockImplementation((row) => {
      const resolved = original(row);
      return { ...resolved, binding: { ...resolved.binding, adapterVersion: "changed" } };
    });
    const response = await approveAndExecuteActionApproval(env, identity, first.approval);
    expect(await response.json()).toMatchObject({ code: "action_review_changed" });
    expect(dispatch).not.toHaveBeenCalled();
    changed.mockRestore();
    expect((await approveAndExecuteActionApproval(env, identity, first.approval)).status).toBe(200);
    db.function("strftime", { varargs: true }, () =>
      new Date(Date.now() + 16 * 60_000).toISOString(),
    );
    expect(await expireActionReviews(env)).toEqual({ selected: 0 });
    expect(db.prepare("SELECT status FROM control_action_proposals").get()!.status).toBe(
      "executed",
    );
  });
});
