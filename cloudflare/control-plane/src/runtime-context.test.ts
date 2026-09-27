import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureRuntimeContext, handleGetContextSnapshot } from "./runtime-context";
import { executeRuntimeWorkflowRequest } from "./runtime-workflows";
import {
  createAgentBehaviorSnapshotFromTemplate,
  toPackTemplate,
} from "./agent-behavior-templates";
import { agentManifestRegistry } from "../../../generated/agent-runtime/manifests";
import { createRuntimeStatePort } from "./runtime-state";
import { controlPlane } from "../../../examples/document-review/control-plane";
import { createRuntimeClient } from "../../../packages/client/src/runtime-client";
import { exportCollections, loadCollection } from "./workspace-data-export-core";
import { purgeWorkspace } from "./workspace-data-jobs";
import { executeResolvedRuntimeAdminTool } from "./runtime-admin-execution";
import type { AgentIdentity, ControlDataJobRow, D1PreparedStatement, Env } from "./types";
const manifest = agentManifestRegistry["document-review"].module;
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});
const identity: AgentIdentity = { scope: { userId: "u", workspaceId: "w" }, agentId: "a" };
const fixture = () => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec(`INSERT INTO agents (id,workspace_id,name,status,created_by_user_id,created_at,updated_at)
    VALUES ('a','w','Agent','active','u','now','now');
    INSERT INTO users (id,status,created_at,updated_at) VALUES ('u','active','now','now');
    INSERT INTO workspaces (id,account_id,account_source,name,status,created_by_user_id,created_at,updated_at)
      VALUES ('w','acct','local','Workspace','active','u','now','now');
    INSERT INTO memberships (id,user_id,workspace_id,role,status,created_at,updated_at)
      VALUES ('m','u','w','owner','active','now','now');
    INSERT INTO chat_threads (thread_id,session_id,user_id,workspace_id,agent_id,status,created_at,updated_at,last_seen_at)
      VALUES ('t','s','u','w','a','active','now','now','now');`);
  type Statement = D1PreparedStatement & {
    execute(): { success: true; meta: { changes: number } };
  };
  const env = {
    DB: {
      prepare(query: string): Statement {
        let values: unknown[] = [];
        const statement: Statement = {
          bind(...parameters) {
            if (parameters.length !== (query.match(/\?/g)?.length ?? 0))
              throw new Error("D1 bind count mismatch");
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
  db.prepare(
    "INSERT INTO control_budget_policies (workspace_id,version,limits_json,updated_by_user_id,updated_at) VALUES ('w',1,?,'u','now')",
  ).run(
    JSON.stringify({
      dailyModelCalls: 100,
      dailyToolCalls: 100,
      dailyTokens: 1000000,
      runModelCalls: 10,
      runToolCalls: 10,
      runTokens: 100000,
      concurrentOperations: 10,
    }),
  );
  env.OPERLOOM_CONFORMANCE_MODE = "true";
  const current = createAgentBehaviorSnapshotFromTemplate(toPackTemplate(manifest));
  const old = {
    ...current,
    version: manifest.version,
    pack: { ...current.pack!, version: manifest.version },
  };
  db.prepare("UPDATE agents SET data_json = ? WHERE id = 'a'").run(
    JSON.stringify({ profile: "operator", custom: { retained: true }, behavior: old }),
  );
  return { db, env, old };
};

const review = (env: Env, text?: string) =>
  executeRuntimeWorkflowRequest(
    "document-review.review",
    new Request("https://api/workbench/workflows/document-review.review", {
      method: "POST",
      body: JSON.stringify({
        input: { documentId: "guide", ...(text === undefined ? {} : { text }) },
        executionMode: "dry_run",
      }),
    }),
    env,
    identity,
    { source: "user" },
  );
const seedRun = (db: DatabaseSync, kind: "workflow" | "chat" = "workflow") => {
  if (kind === "workflow")
    db.exec(`INSERT INTO control_runs (id,user_id,workspace_id,agent_id,workflow_intent_id,status,execution_json,data_json,created_at,updated_at)
    VALUES ('run','u','w','a','intent','running','{}','{"agentRevision":0}','now','now')`);
  else
    db.exec(`INSERT INTO chat_runs (id,user_id,workspace_id,agent_id,intent_id,policy_decision_id,thread_id,status,metadata_json,started_at,updated_at)
    VALUES ('run','u','w','a','intent','policy','t','running','{"agentRevision":0}','now','now')`);
};
const capture = (
  env: Env,
  input = { text: "Evidence" },
  runKind: "workflow" | "chat" = "workflow",
) =>
  captureRuntimeContext(env, identity, {
    runId: "run",
    runKind,
    input,
    target: "simulation",
    signal: new AbortController().signal,
  });

describe("canonical scoped context", () => {
  it.each([false, true])(
    "enforces context on direct Admin dispatch (text supplied: %s)",
    async (supplied) => {
      const { env, db } = fixture();
      seedRun(db);
      const execute = vi.fn(async () => ({
        ok: true as const,
        output: { result: "observed" },
        summary: "Observed",
      }));
      const response = await executeResolvedRuntimeAdminTool({
        requestUrl: "https://api/tools/runs",
        env,
        identity,
        policyDecisionId: "policy",
        started: {
          runId: "run",
          workflowIntentId: "intent",
          relation: { kind: "root", rootRunId: "run", depth: 0, durableChild: false },
        },
        toolInput: supplied ? { text: "Evidence" } : {},
        resolved: {
          platformOwned: false,
          packId: "document-review",
          packVersion: "1.0.0",
          runtimeVersion: "1.0.0",
          connections: [],
          binding: {
            id: "review.observe",
            description: "Observe",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
            executionModes: ["dry_run"],
            transport: "cloudflare_inline",
            adapterVersion: "1",
            timeoutMs: 1000,
            maxArtifactBytes: 1000,
            policy: {
              reference: "review.observe",
              adminVisible: true,
              modelVisible: false,
              requiresApproval: false,
              policyEditable: false,
              mutationRisk: "read_only",
            },
            execute,
          },
        },
      });
      expect(response.status).toBe(supplied ? 201 : 409);
      expect(execute).toHaveBeenCalledTimes(supplied ? 1 : 0);
      expect(db.prepare("SELECT status FROM control_runs").get()!.status).toBe(
        supplied ? "completed" : "blocked",
      );
      expect(db.prepare("SELECT status FROM control_context_snapshots").get()!.status).toBe(
        supplied ? "ready" : "blocked",
      );
    },
  );
  it("runs the real document package, persists evidence/decision/state and records unchanged input without another write", async () => {
    const { env, db } = fixture();
    const response = await review(env, "A deterministic document review.");
    expect(response.status).toBe(201);
    const first = await response.json();
    expect(first.report).toMatchObject({ outcome: "reviewed", wordCount: 4 });
    const second = await (await review(env, "A deterministic document review.")).json();
    expect(second.report.outcome).toBe("no_change");
    expect(db.prepare("SELECT version FROM control_state_records").get()!.version).toBe(1);
    expect(db.prepare("SELECT count(*) n FROM control_state_entries").get()!.n).toBe(2);
    const decision = db
      .prepare("SELECT data_json FROM control_state_entries WHERE entry_key = ?")
      .get(second.report.decisionId)!;
    expect(JSON.parse(String(decision.data_json))).toMatchObject({
      outcome: "no_change",
      snapshotId: second.report.snapshotId,
    });
    const snapshots = await loadCollection(
      env,
      identity,
      exportCollections.find((item) => item.name === "control_context_snapshots")!,
    );
    expect(snapshots.length).toBe(2);
    expect(snapshots.every((row) => row.status === "ready")).toBe(true);
    expect(() => db.exec("UPDATE control_context_snapshots SET status = 'blocked'")).toThrow(
      "context_snapshot_immutable",
    );
    const client = createRuntimeClient({
      baseUrl: "https://api",
      target: { workspaceId: "w", agentId: "a" },
      getAccessToken: async () => "test",
      fetch: (async () =>
        handleGetContextSnapshot(env, identity, first.report.snapshotId)) as typeof fetch,
    });
    expect(
      (await client.context.snapshot(first.report.snapshotId)).snapshot.sources[0],
    ).toMatchObject({ trust: "untrusted", status: "fresh" });
  });
  it("finishes a missing required source as blocked without running the workflow", async () => {
    const { env, db } = fixture();
    const response = await review(env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "context_blocked",
      run: { status: "blocked" },
    });
    expect(db.prepare("SELECT status FROM control_runs").get()!.status).toBe("blocked");
    expect(db.prepare("SELECT status FROM control_context_snapshots").get()!.status).toBe(
      "blocked",
    );
    expect(db.prepare("SELECT count(*) n FROM control_state_records").get()!.n).toBe(0);
  });
  it("captures once, rejects changed input and uses the same rules for chat", async () => {
    const { env, db } = fixture();
    seedRun(db, "chat");
    const resolve = vi.spyOn(controlPlane.context![0], "resolve");
    const first = await capture(env, { text: "Evidence" }, "chat");
    expect((await capture(env, { text: "Evidence" }, "chat"))?.snapshot).toEqual(first?.snapshot);
    expect(resolve).toHaveBeenCalledTimes(1);
    await expect(capture(env, { text: "Changed" }, "chat")).rejects.toMatchObject({
      code: "context_snapshot_conflict",
    });
    const run = db.prepare("SELECT metadata_json FROM chat_runs").get()!;
    expect(JSON.parse(String(run.metadata_json)).contextSnapshotId).toBe(first!.snapshot.id);
  });
  it("rolls back snapshot and run linkage if event publication fails", async () => {
    const { env, db } = fixture();
    seedRun(db);
    db.exec(
      "CREATE TRIGGER fail_context BEFORE INSERT ON control_plane_events BEGIN SELECT RAISE(ABORT,'failure'); END",
    );
    await expect(capture(env)).rejects.toMatchObject({ code: "context_persist_failed" });
    expect(db.prepare("SELECT count(*) n FROM control_context_snapshots").get()!.n).toBe(0);
    expect(
      JSON.parse(String(db.prepare("SELECT data_json FROM control_runs").get()!.data_json))
        .contextSnapshotId,
    ).toBeUndefined();
  });
  it("rechecks authority after collection and fences quarantine", async () => {
    const { env, db } = fixture();
    seedRun(db);
    const original = controlPlane.context![0].resolve;
    vi.spyOn(controlPlane.context![0], "resolve").mockImplementation((input) => {
      db.exec("UPDATE memberships SET status = 'revoked'");
      return original(input);
    });
    await expect(capture(env)).rejects.toMatchObject({ code: "context_authority_revoked" });
    expect(db.prepare("SELECT count(*) n FROM control_context_snapshots").get()!.n).toBe(0);
    vi.restoreAllMocks();
    db.exec("UPDATE memberships SET status = 'active'");
    const captured = await capture(env);
    db.exec("UPDATE workspaces SET status = 'quarantined'");
    expect((await handleGetContextSnapshot(env, identity, captured!.snapshot.id)).status).toBe(404);
    db.exec("UPDATE workspaces SET status = 'active'");
    expect((await handleGetContextSnapshot(env, identity, captured!.snapshot.id)).status).toBe(200);
    expect(
      (
        await handleGetContextSnapshot(
          env,
          { ...identity, scope: { userId: "other", workspaceId: "w" } },
          captured!.snapshot.id,
        )
      ).status,
    ).toBe(404);
  });
  it.each(["cancel", "kill", "export"] as const)(
    "rolls back publication when %s wins during collection",
    async (action) => {
      const { env, db } = fixture();
      seedRun(db);
      const original = controlPlane.context![0].resolve;
      vi.spyOn(controlPlane.context![0], "resolve").mockImplementation((input) => {
        if (action === "cancel") db.exec("UPDATE control_runs SET status = 'cancelled'");
        else if (action === "kill")
          db.exec(`INSERT INTO control_kill_switches (id,user_id,workspace_id,scope_kind,scope_id,enabled,reason,created_by_user_id,created_at,updated_at)
        VALUES ('kill','u','w','pack','document-review',1,'test','u','now','now')`);
        else
          db.exec(`INSERT INTO control_workspace_write_fences (workspace_id,job_id,status,lease_owner,lease_expires_at,acquired_at,updated_at)
        VALUES ('w','export','active','owner','2999-01-01T00:00:00Z','now','now')`);
        return original(input);
      });
      await expect(capture(env)).rejects.toMatchObject({
        code: action === "export" ? "workspace_export_in_progress" : "context_authority_revoked",
      });
      expect(db.prepare("SELECT count(*) n FROM control_context_snapshots").get()!.n).toBe(0);
      expect(
        JSON.parse(String(db.prepare("SELECT data_json FROM control_runs").get()!.data_json))
          .contextSnapshotId,
      ).toBeUndefined();
    },
  );
  it("purges retained context through the lifecycle D1 phase", async () => {
    const { env, db } = fixture();
    seedRun(db);
    await capture(env);
    db.exec(`UPDATE workspaces SET status = 'purging', purge_after = '2000-01-01T00:00:00Z';
      INSERT INTO control_data_jobs (id,user_id,workspace_id,kind,status,cursor_json,created_by_user_id,created_at,updated_at)
      VALUES ('purge','u','w','purge','running','{"phase":"objects_deleted"}','u','now','now')`);
    const job = db
      .prepare("SELECT * FROM control_data_jobs WHERE id = 'purge'")
      .get() as unknown as ControlDataJobRow;
    await purgeWorkspace(env, identity, job);
    expect(db.prepare("SELECT count(*) n FROM control_context_snapshots").get()!.n).toBe(0);
    expect(db.prepare("SELECT count(*) n FROM control_deletion_receipts").get()!.n).toBe(1);
  });
  it("rejects a typed commit using evidence from another target", async () => {
    const { env, db } = fixture();
    seedRun(db);
    const evidence = await capture(env);
    const state = await createRuntimeStatePort(env, identity, {
      packId: "document-review",
      target: "external",
      definitions: controlPlane.state!,
      contextSnapshotId: evidence!.snapshot.id,
    });
    await expect(
      state.commit({
        idempotencyKey: "wrong-target",
        reads: [],
        writes: [],
        entries: [{ id: "decision", type: "decision", data: { outcome: "test" } }],
      }),
    ).rejects.toMatchObject({ code: "state_conflict" });
    expect(db.prepare("SELECT count(*) n FROM control_state_entries").get()!.n).toBe(0);
    expect(db.prepare("SELECT count(*) n FROM control_state_commits").get()!.n).toBe(0);
  });
  it("rejects a typed commit against expired required evidence atomically", async () => {
    const { env, db } = fixture();
    db.exec(`INSERT INTO control_context_snapshots (id,user_id,workspace_id,agent_id,run_id,run_kind,agent_revision,pack_id,request_hash,snapshot_json,status,created_at,preconditions_met)
      VALUES ('expired','u','w','a','run','workflow',0,'document-review','hash','{"target":"simulation","sources":[{"required":true,"status":"fresh","expiresAt":"2000-01-01T00:00:00Z"}]}','ready','now',1)`);
    const state = await createRuntimeStatePort(env, identity, {
      packId: "document-review",
      target: "simulation",
      definitions: controlPlane.state!,
      contextSnapshotId: "expired",
    });
    await expect(
      state.commit({
        idempotencyKey: "write",
        reads: [{ namespace: "documents", kind: "review", key: "guide", version: 0 }],
        writes: [
          {
            namespace: "documents",
            kind: "review",
            key: "guide",
            schemaVersion: 1,
            data: { contentHash: "hash", wordCount: 1, status: "reviewed" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "state_conflict" });
    expect(db.prepare("SELECT count(*) n FROM control_state_records").get()!.n).toBe(0);
    expect(db.prepare("SELECT count(*) n FROM control_state_commits").get()!.n).toBe(0);
  });
});

it("stores snapshots without capture fields byte-for-byte as immutable revision zero", () => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const original = '{ "retained": true, "id": "historical" }';
  db.prepare(
    `INSERT INTO control_context_snapshots
      (id,user_id,workspace_id,agent_id,run_id,run_kind,agent_revision,pack_id,request_hash,snapshot_json,status,created_at,preconditions_met)
      VALUES ('historical','u','w','a','run','workflow',0,'pack','request',?,'ready','now',1)`,
  ).run(original);
  expect(
    db
      .prepare(
        "SELECT id,snapshot_json,capture_key,revision,step_id FROM control_context_snapshots",
      )
      .get(),
  ).toEqual({
    id: "historical",
    snapshot_json: original,
    capture_key: "run",
    revision: 0,
    step_id: null,
  });
  expect(() => db.exec("UPDATE control_context_snapshots SET revision=1")).toThrow(
    "context_snapshot_immutable",
  );
});
