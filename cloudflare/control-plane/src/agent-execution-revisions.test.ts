import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createAllowedChatRunBoundary, createAgentChatRunStartMirror } from "./chat-boundary-store";
import { startPackWorkflowRun } from "./runtime-run-lifecycle";
import { createRuntimeToolApproval } from "./tool-approvals";
import type { AgentIdentity, D1PreparedStatement, Env } from "./types";
import { selectAgent, selectDefaultAgent, selectWorkspaceAgents } from "./authz-store";
import { sweepExpiredOperationalData } from "./artifact-lifecycle";
import { updateControlRunStatus } from "./control-run-store";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const identity: AgentIdentity = { scope: { userId: "u", workspaceId: "w" }, agentId: "a" };
const fixture = () => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec(`INSERT INTO agents (id,workspace_id,name,status,created_by_user_id,created_at,updated_at)
    VALUES ('a','w','Agent','active','u','now','now');`);
  type Statement = D1PreparedStatement & {
    execute(): { success: true; meta: { changes: number } };
  };
  const env = {
    DB: {
      prepare(query: string): Statement {
        let values: unknown[] = [];
        const statement: Statement = {
          bind(...parameters) {
            values = parameters;
            return statement;
          },
          async first<T>() {
            return (db.prepare(query).get(...(values as never[])) ?? null) as T | null;
          },
          async all<T>() {
            return { results: db.prepare(query).all(...(values as never[])) as T[] };
          },
          async run() {
            return statement.execute();
          },
          execute() {
            return {
              success: true,
              meta: { changes: Number(db.prepare(query).run(...(values as never[])).changes) },
            };
          },
        };
        return statement;
      },
      async batch(statements: Statement[]) {
        db.exec("BEGIN");
        try {
          const results = statements.map((statement) => statement.execute());
          db.exec("COMMIT");
          return results;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
  } as unknown as Env;
  const advance = () =>
    db.exec("UPDATE agents SET runtime_revision = runtime_revision + 1 WHERE id = 'a'");
  return { db, env, advance };
};

const admissions = {
  workflow: (env: Env, who: AgentIdentity) =>
    startPackWorkflowRun(env, who, {
      workflowType: "revision.fixture",
      policyReference: "test",
      displayName: "Revision fixture",
      packId: "test",
      toolInput: {},
      executionMode: "dry_run",
      engine: "cloudflare",
      // Caller metadata cannot substitute a different admission generation.
      runtimeMetadata: { agentRevision: 999 },
    }),
  approval: (env: Env, who: AgentIdentity) =>
    createRuntimeToolApproval({
      env,
      identity: who,
      toolName: "test.observe",
      toolInput: {},
      policyDecisionId: "policy",
      policyReference: "test",
      reason: "Review",
      packId: "test",
      packVersion: "1.0.0",
      runtimeVersion: "1.0.0",
      bindingVersion: 1,
      transport: "cloudflare_inline",
    }),
  chat: (env: Env, who: AgentIdentity) =>
    createAllowedChatRunBoundary(env, who, {
      sessionId: "s",
      threadId: "t",
      executionMode: "ask",
      payload: {},
      reason: "Allow",
      metadata: { agentRevision: 999 },
    }),
  agentChat: (env: Env, who: AgentIdentity) =>
    createAgentChatRunStartMirror(env, who, {
      sessionId: "s",
      threadId: "t",
      traceId: "trace",
      traceStartedAtMs: 1,
      tokenVerifyStartedAtMs: 1,
      tokenVerifyEndedAtMs: 2,
      configResolveStartedAtMs: 2,
      configResolveEndedAtMs: 3,
      configCacheStatus: "miss",
      agentMetadata: {},
      model: "test",
      runtimeConfig: {},
      behavior: {},
    }),
};

describe("database execution revision boundary", () => {
  it("canonical agent queries retain the server generation", async () => {
    const { env, db, advance } = fixture();
    advance();
    db.exec("UPDATE agents SET is_default = 1");
    expect(await selectAgent(env, "a", "w")).toMatchObject({ runtime_revision: 1 });
    expect(await selectDefaultAgent(env, "w")).toMatchObject({ runtime_revision: 1 });
    expect((await selectWorkspaceAgents(env, "w")).results[0]).toMatchObject({
      runtime_revision: 1,
    });
    expect(await selectAgent(env, "a", "other-workspace")).toBeNull();
  });

  it("retains admission provenance through status updates and payload pruning", async () => {
    const { env, db, advance } = fixture();
    advance();
    const run = await admissions.workflow(env, { ...identity, agentRevision: 1 });
    await updateControlRunStatus(env, {
      ...identity,
      runId: run.runId,
      workflowIntentId: run.workflowIntentId,
      status: "completed",
      summary: "Completed",
      data: { agentRevision: 999 },
    });
    expect(
      JSON.parse(db.prepare("SELECT data_json FROM control_runs").get()!.data_json as string)
        .agentRevision,
    ).toBe(1);
    await sweepExpiredOperationalData(env, { now: new Date("2100-01-01T00:00:00Z") });
    const data = JSON.parse(
      db.prepare("SELECT data_json FROM control_runs").get()!.data_json as string,
    );
    expect(data).toMatchObject({ agentRevision: 1, payloadPrunedAt: "2100-01-01T00:00:00.000Z" });
    advance();
    expect(() => db.exec("UPDATE control_runs SET status = 'running'")).toThrow(
      "agent_runtime_revision_conflict",
    );
  });
  for (const [name, admit] of Object.entries(admissions)) {
    it(`${name}: accepts legacy generation zero and blocks revision changes while work is active`, async () => {
      const { env, db, advance } = fixture();
      await admit(env, identity);
      expect(() => advance()).toThrow("agent_runtime_revision_busy");
      expect(db.prepare("SELECT runtime_revision FROM agents").get()).toEqual({
        runtime_revision: 0,
      });
      const row = db
        .prepare(
          "SELECT data_json AS metadata FROM control_runs UNION ALL SELECT metadata_json AS metadata FROM chat_runs LIMIT 1",
        )
        .get();
      expect(JSON.parse(row!.metadata as string).agentRevision).toBe(0);
    });

    it(`${name}: rejects stale admission after a revision change and rolls back every earlier write`, async () => {
      const { env, db, advance } = fixture();
      advance();
      await expect(admit(env, identity)).rejects.toThrow("agent_runtime_revision_conflict");
      for (const table of [
        "control_runs",
        "control_workflow_intents",
        "control_approval_requests",
        "control_audit_events",
        "control_plane_events",
        "chat_runs",
        "chat_intents",
        "chat_policy_decisions",
        "runtime_traces",
        "runtime_spans",
      ])
        expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({
          count: 0,
        });
      await admit(env, { ...identity, agentRevision: 1 });
    });
  }

  it("rejects stale resume, permits terminal bookkeeping, and never reuses a generation", async () => {
    const { env, db, advance } = fixture();
    const run = await admissions.workflow(env, identity);
    db.prepare("UPDATE control_runs SET status = 'completed' WHERE id = ?").run(run.runId);
    advance();
    expect(() =>
      db
        .prepare(
          "UPDATE control_runs SET status = 'running', data_json = json_set(data_json, '$.agentRevision', 1) WHERE id = ?",
        )
        .run(run.runId),
    ).toThrow("agent_runtime_revision_conflict");
    expect(() =>
      db.prepare("UPDATE control_runs SET status = 'running' WHERE id = ?").run(run.runId),
    ).toThrow("agent_runtime_revision_conflict");
    expect(() =>
      db
        .prepare(
          "UPDATE control_runs SET data_json = json_set(data_json, '$.summary', 'Retained') WHERE id = ?",
        )
        .run(run.runId),
    ).not.toThrow();
    expect(() => db.exec("UPDATE agents SET runtime_revision = 0")).toThrow(
      "agent_runtime_revision_invalid",
    );
    expect(() => db.exec("UPDATE agents SET runtime_revision = 3")).toThrow(
      "agent_runtime_revision_invalid",
    );
    advance();
    expect(db.prepare("SELECT runtime_revision FROM agents").get()).toEqual({
      runtime_revision: 2,
    });
  });
});
