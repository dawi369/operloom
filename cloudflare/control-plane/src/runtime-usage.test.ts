import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateText } from "ai";
import {
  createAgentBehaviorSnapshotFromTemplate,
  toPackTemplate,
} from "./agent-behavior-templates";
import { agentManifestRegistry } from "../../../generated/agent-runtime/manifests";
import {
  defaultRuntimeBudgetLimits,
  reserveRuntimeUsage,
  settleRuntimeUsage,
  handleRuntimeBudgets,
} from "./runtime-usage";
import { createRuntimeModelPort } from "./runtime-models";
import { createChatUsageTracker } from "./chat-usage";
import { captureRuntimeContext } from "./runtime-context";
import { createRuntimeClient } from "../../../packages/client/src/runtime-client";
import { exportCollections, loadCollection } from "./workspace-data-export-core";
import { purgeWorkspace } from "./workspace-data-jobs";
import type { RuntimeBudgetLimits } from "../../../packages/client/src/public-budget-contracts";
import type { AgentIdentity, ControlDataJobRow, D1PreparedStatement, Env } from "./types";
vi.mock("ai", async (original) => ({
  ...(await original<typeof import("ai")>()),
  generateText: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(generateText).mockReset();
  vi.mocked(generateText).mockResolvedValue({
    output: { summary: "Observed evidence" },
    usage: { inputTokens: 10, outputTokens: 5 },
  } as never);
});
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
  env.OPENROUTER_API_KEY = "synthetic-test-key";
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

const limits: RuntimeBudgetLimits = {
  dailyModelCalls: 10,
  dailyToolCalls: 10,
  dailyTokens: 1000000,
  runModelCalls: 5,
  runToolCalls: 5,
  runTokens: 100000,
  concurrentOperations: 5,
};
const configure = (
  env: Env,
  changes: Partial<RuntimeBudgetLimits> = {},
  expectedVersion = 0,
  idempotencyKey = "policy",
) =>
  handleRuntimeBudgets(
    new Request("https://api/workbench/budgets", {
      method: "PUT",
      body: JSON.stringify({ expectedVersion, idempotencyKey, limits: { ...limits, ...changes } }),
    }),
    env,
    identity,
  );
const run = (db: DatabaseSync, id = "run", user = "u", parent?: string) =>
  db
    .prepare(`INSERT INTO control_runs (id,user_id,workspace_id,agent_id,workflow_intent_id,status,execution_json,data_json,created_at,updated_at)
 VALUES (?,?,'w','a','intent','running','{}',?,'now','now')`)
    .run(
      id,
      user,
      JSON.stringify({ agentRevision: 0, ...(parent ? { parentRunId: parent } : {}) }),
    );
const reserve = (env: Env, key = "one", actor = identity, runId = "run") =>
  reserveRuntimeUsage(env, actor, {
    runId,
    runKind: "workflow",
    packId: "document-review",
    kind: "model",
    operationKey: key,
    payload: { prompt: "observe" },
    estimatedInputTokens: 10,
    maxOutputTokens: 20,
  });
const request = {
  idempotencyKey: "summary",
  prompt: "Summarize the document",
  outputSchema: {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    additionalProperties: false,
  },
  maxOutputTokens: 100,
};

describe("resource reservations and structured models", () => {
  it("pins the effective model configuration in decision evidence even when inherited from the environment", async () => {
    const { env, db } = fixture();
    run(db);
    const input = {
      runId: "run",
      runKind: "workflow" as const,
      input: { text: "Evidence" },
      target: "simulation" as const,
      signal: new AbortController().signal,
    };
    env.OPENROUTER_MODEL = "openai/gpt-6-luna";
    const first = await captureRuntimeContext(env, identity, input);
    env.OPENROUTER_MODEL = "openai/gpt-4.1-mini";
    await expect(captureRuntimeContext(env, identity, input)).rejects.toMatchObject({
      code: "context_snapshot_conflict",
    });
    run(db, "new-model");
    const next = await captureRuntimeContext(env, identity, { ...input, runId: "new-model" });
    expect(next!.snapshot.contentHash).toBe(first!.snapshot.contentHash);
    expect(next!.snapshot.configurationHash).not.toBe(first!.snapshot.configurationHash);
  });
  it("blocks missing and expired required context before provider admission", async () => {
    const { env, db } = fixture();
    await configure(env);
    run(db);
    const signal = new AbortController().signal;
    const missing = await captureRuntimeContext(env, identity, {
      runId: "run",
      runKind: "workflow",
      input: {},
      target: "simulation",
      signal,
    });
    await expect(
      createRuntimeModelPort(env, identity, { runId: "run", signal, context: missing }).structured(
        request,
      ),
    ).rejects.toMatchObject({ code: "context_blocked" });
    run(db, "expired");
    const snapshot = {
      ...missing!.snapshot,
      id: "expired-context",
      runId: "expired",
      status: "ready" as const,
      sources: missing!.snapshot.sources.map((source) => ({
        ...source,
        status: "fresh" as const,
        expiresAt: "2000-01-01T00:00:00.000Z",
      })),
    };
    db.prepare(`INSERT INTO control_context_snapshots
      (id,user_id,workspace_id,agent_id,run_id,run_kind,agent_revision,pack_id,request_hash,snapshot_json,status,created_at,preconditions_met)
      VALUES ('expired-context','u','w','a','expired','workflow',0,'document-review','hash',?,'ready','now',1)`).run(
      JSON.stringify(snapshot),
    );
    // Even a previously successful in-memory check cannot bypass the database freshness fence.
    await expect(
      createRuntimeModelPort(env, identity, {
        runId: "expired",
        signal,
        context: { snapshot, assertReady() {} },
      }).structured(request),
    ).rejects.toMatchObject({ code: "resource_admission_denied" });
    expect(generateText).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) n FROM control_resource_reservations").get()!.n).toBe(0);
  });
  it("rolls back budget updates and settlement events on a later transaction failure", async () => {
    const { env, db } = fixture();
    await configure(env);
    db.exec(`CREATE TRIGGER fail_budget BEFORE INSERT ON control_plane_events WHEN NEW.type = 'budget.updated'
      BEGIN SELECT RAISE(ABORT,'late'); END`);
    expect((await configure(env, { dailyModelCalls: 0 }, 1, "new-policy")).status).toBe(409);
    expect(db.prepare("SELECT version FROM control_budget_policies").get()!.version).toBe(1);
    expect(db.prepare("SELECT COUNT(*) n FROM control_budget_changes").get()!.n).toBe(1);
    db.exec("DROP TRIGGER fail_budget");
    run(db);
    const claim = await reserve(env);
    db.exec(`CREATE TRIGGER fail_settlement BEFORE UPDATE ON control_resource_reservations
      BEGIN SELECT RAISE(ABORT,'late'); END`);
    await expect(
      settleRuntimeUsage(env, claim.reservation, { status: "unknown" }),
    ).rejects.toThrow();
    expect(db.prepare("SELECT status FROM control_resource_reservations").get()!.status).toBe(
      "reserved",
    );
    expect(
      db.prepare("SELECT COUNT(*) n FROM control_plane_events WHERE type='usage.settled'").get()!.n,
    ).toBe(0);
    db.exec("DROP TRIGGER fail_settlement");
    await settleRuntimeUsage(env, claim.reservation, { status: "unknown" });
    await settleRuntimeUsage(env, claim.reservation, { status: "unknown" });
    expect(
      db.prepare("SELECT COUNT(*) n FROM control_plane_events WHERE type='usage.settled'").get()!.n,
    ).toBe(1);
  });
  it("paginates usage metadata without output and separates fixtures from provider usage", async () => {
    const { env, db } = fixture();
    await configure(env);
    run(db);
    const client = createRuntimeClient({
      baseUrl: "https://api",
      target: { workspaceId: "w", agentId: "a" },
      getAccessToken: async () => "test",
      fetch: (async (url, init) =>
        handleRuntimeBudgets(new Request(String(url), init), env, identity)) as typeof fetch,
    });
    for (const source of ["fixture", "provider"] as const) {
      const claim = await reserve(env, source);
      await settleRuntimeUsage(env, claim.reservation, {
        status: "settled",
        source,
        inputTokens: 4,
        outputTokens: 2,
        result: { summary: "private-result" },
      });
    }
    const snapshot = await client.budgets.get();
    expect(snapshot.usage).toMatchObject({ knownTokens: 6, fixtureTokens: 6, estimatedTokens: 0 });
    const first = await client.budgets.usage({ day: snapshot.day, limit: 1 });
    expect(first.reservations).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = await client.budgets.usage({
      day: snapshot.day,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.reservations).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    expect(second.reservations[0].id).not.toBe(first.reservations[0].id);
    expect(JSON.stringify([first, second])).not.toContain("private-result");
    expect(first.reservations[0]).not.toHaveProperty("result_json");
    db.exec("UPDATE memberships SET role='member'");
    await expect(client.budgets.usage({ day: snapshot.day })).rejects.toMatchObject({
      status: 403,
    });
  });
  it("applies default workspace limits when no administrator policy exists", async () => {
    const { env, db } = fixture();
    run(db);
    const claim = await reserve(env);
    expect(claim.fresh).toBe(true);
    const policy = db
      .prepare("SELECT version, limits_json, updated_by_user_id FROM control_budget_policies")
      .get() as { version: number; limits_json: string; updated_by_user_id: string };
    expect(policy.version).toBe(1);
    expect(policy.updated_by_user_id).toBe("system");
    expect(JSON.parse(policy.limits_json)).toEqual(defaultRuntimeBudgetLimits);
    expect((await configure(env, {}, 1, "tuned")).status).toBe(200);
  });
  it("counts chat follow-up steps and child tools against the same run budget", async () => {
    const { env, db } = fixture();
    await configure(env, { runModelCalls: 1, runToolCalls: 1 });
    db.exec(`INSERT INTO chat_runs (id,intent_id,policy_decision_id,thread_id,user_id,workspace_id,agent_id,status,metadata_json,started_at,updated_at)
      VALUES ('chat','intent','policy','t','u','w','a','running','{"agentRevision":0}','now','now')`);
    run(db, "child", "u", "chat");
    const tracker = createChatUsageTracker(env, identity, {
      runId: "chat",
      packId: "document-review",
      model: "test",
      maxOutputTokens: 100,
      system: "Observe",
      signal: new AbortController().signal,
    });
    await tracker.beforeStep(0, [{ role: "user", content: "Evidence" }]);
    const tool = await reserveRuntimeUsage(env, identity, {
      runId: "child",
      runKind: "workflow",
      packId: "document-review",
      kind: "tool",
      operationKey: "observe",
      payload: {},
    });
    expect(tool.reservation.budget_run_id).toBe("chat");
    expect(tool.reservation.budget_run_kind).toBe("chat");
    await tracker.afterStep(0, { inputTokens: 5, outputTokens: 3 });
    await expect(tracker.beforeStep(1, [{ role: "user", content: "More" }])).rejects.toMatchObject({
      code: "resource_admission_denied",
    });
    expect(
      db.prepare("SELECT COUNT(*) n FROM control_resource_reservations WHERE kind='model'").get()!
        .n,
    ).toBe(1);
  });
  it("checks revocation at the reservation transaction and lets already-incurred usage settle afterward", async () => {
    const { env, db } = fixture();
    await configure(env);
    run(db);
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce((statements) => {
      db.exec("UPDATE memberships SET status='revoked'");
      return batch(statements);
    });
    await expect(reserve(env)).rejects.toMatchObject({ code: "usage_scope_denied" });
    expect(db.prepare("SELECT COUNT(*) n FROM control_resource_reservations").get()!.n).toBe(0);
    db.exec("UPDATE memberships SET status='active'");
    const claim = await reserve(env);
    db.exec("UPDATE memberships SET status='revoked'");
    await settleRuntimeUsage(env, claim.reservation, {
      status: "settled",
      inputTokens: 2,
      outputTokens: 1,
      source: "provider",
    });
    expect(
      db.prepare("SELECT input_tokens FROM control_resource_reservations").get()!.input_tokens,
    ).toBe(2);
  });
  it("retains known usage from provider validation errors without exposing the response body", async () => {
    const { env, db } = fixture();
    await configure(env);
    run(db);
    vi.mocked(generateText).mockRejectedValueOnce(
      Object.assign(new Error("private provider body"), {
        usage: { inputTokens: 20, outputTokens: 4 },
      }),
    );
    await expect(
      createRuntimeModelPort(env, identity, {
        runId: "run",
        signal: new AbortController().signal,
      }).structured(request),
    ).rejects.toMatchObject({ code: "model_call_failed" });
    expect(
      db
        .prepare("SELECT input_tokens,output_tokens,status FROM control_resource_reservations")
        .get(),
    ).toMatchObject({ input_tokens: 20, output_tokens: 4, status: "settled" });
    expect(
      JSON.stringify(db.prepare("SELECT * FROM control_resource_reservations").get()),
    ).not.toContain("private provider body");
  });
  it("leaves a charged receipt after settlement fails and does not repeat the provider call", async () => {
    const { env, db } = fixture();
    await configure(env);
    run(db);
    vi.mocked(generateText).mockImplementationOnce(async () => {
      db.exec(`INSERT INTO control_workspace_write_fences (workspace_id,job_id,status,lease_owner,lease_expires_at,acquired_at,updated_at)
        VALUES ('w','export','active','owner','2999-01-01T00:00:00Z','now','now')`);
      return {
        output: { summary: "Observed" },
        usage: { inputTokens: 5, outputTokens: 2 },
      } as never;
    });
    const model = createRuntimeModelPort(env, identity, {
      runId: "run",
      signal: new AbortController().signal,
    });
    await expect(model.structured(request)).rejects.toMatchObject({
      code: "model_outcome_unknown",
    });
    db.exec("DELETE FROM control_workspace_write_fences");
    await expect(model.structured(request)).rejects.toMatchObject({
      code: "model_outcome_unknown",
    });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(
      db.prepare("SELECT status,reserved_tokens FROM control_resource_reservations").get()!
        .reserved_tokens,
    ).toBeGreaterThan(100);
  });
  it("exposes canonical policy through Fetch with role, CAS and replay enforcement", async () => {
    const { env, db } = fixture();
    const client = createRuntimeClient({
      baseUrl: "https://api",
      target: { workspaceId: "w", agentId: "a" },
      getAccessToken: async () => "test",
      fetch: (async (url, init) =>
        handleRuntimeBudgets(new Request(String(url), init), env, identity)) as typeof fetch,
    });
    const update = { expectedVersion: 0, idempotencyKey: "policy", limits };
    const result = await client.budgets.update(update);
    expect(await client.budgets.update(update)).toEqual(result);
    expect((await client.budgets.get()).policy?.version).toBe(1);
    expect((await configure(env, { dailyModelCalls: 1 })).status).toBe(409);
    expect((await configure(env, {}, 0, "other")).status).toBe(409);
    db.exec("UPDATE memberships SET role='member'");
    expect((await configure(env, {}, 1, "member")).status).toBe(403);
  });
  it("serializes concurrent admissions across workspace members", async () => {
    const { env, db } = fixture();
    await configure(env, { dailyModelCalls: 1 });
    run(db);
    db.exec(`INSERT INTO users (id,status,created_at,updated_at) VALUES ('other','active','now','now');
      INSERT INTO memberships (id,user_id,workspace_id,role,status,created_at,updated_at) VALUES ('other','other','w','member','active','now','now')`);
    run(db, "other-run", "other");
    const outcomes = await Promise.allSettled([
      reserve(env),
      reserve(
        env,
        "two",
        { ...identity, scope: { userId: "other", workspaceId: "w" } },
        "other-run",
      ),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) n FROM control_resource_reservations").get()!.n).toBe(1);
  });
  it("keeps child usage under the canonical parent run limit", async () => {
    const { env, db } = fixture();
    await configure(env, { runModelCalls: 1 });
    run(db);
    run(db, "child", "u", "run");
    await reserve(env);
    await expect(reserve(env, "child", identity, "child")).rejects.toMatchObject({
      code: "resource_admission_denied",
    });
    run(db, "independent");
    expect((await reserve(env, "new", identity, "independent")).fresh).toBe(true);
  });
  it("replays receipts, rejects changed content and reports known and estimated usage separately", async () => {
    const { env, db } = fixture();
    await configure(env);
    run(db);
    const claim = await reserve(env);
    expect(claim.fresh).toBe(true);
    expect((await reserve(env)).fresh).toBe(false);
    await expect(
      reserveRuntimeUsage(env, identity, {
        runId: "run",
        runKind: "workflow",
        packId: "document-review",
        kind: "model",
        operationKey: "one",
        payload: { prompt: "changed" },
        estimatedInputTokens: 10,
        maxOutputTokens: 20,
      }),
    ).rejects.toMatchObject({ code: "usage_key_conflict" });
    await settleRuntimeUsage(env, claim.reservation, {
      status: "settled",
      inputTokens: 4,
      outputTokens: 2,
      source: "provider",
    });
    await settleRuntimeUsage(env, claim.reservation, {
      status: "settled",
      inputTokens: 4,
      outputTokens: 2,
      source: "provider",
    });
    const unknown = await reserve(env, "unknown");
    await settleRuntimeUsage(env, unknown.reservation, {
      status: "unknown",
      errorCode: "response_lost",
    });
    const snapshot = await (
      await handleRuntimeBudgets(new Request("https://api/workbench/budgets"), env, identity)
    ).json();
    expect(snapshot.usage).toMatchObject({
      modelCalls: 2,
      knownTokens: 6,
      estimatedTokens: 30,
      activeOperations: 0,
      unresolvedOperations: 1,
    });
    await expect(
      settleRuntimeUsage(env, claim.reservation, {
        status: "settled",
        inputTokens: 0,
        outputTokens: 0,
        source: "provider",
      }),
    ).rejects.toMatchObject({ code: "usage_settlement_conflict" });
  });
  it("retains ambiguous usage and stops further calls when token or concurrency limits are exhausted", async () => {
    const { env, db } = fixture();
    await configure(env, { dailyTokens: 30, concurrentOperations: 1 });
    run(db);
    const claim = await reserve(env);
    await expect(reserve(env, "two")).rejects.toMatchObject({ code: "resource_admission_denied" });
    await settleRuntimeUsage(env, claim.reservation, { status: "unknown" });
    await expect(reserve(env, "three")).rejects.toMatchObject({
      code: "resource_admission_denied",
    });
  });
  it("rolls back admission on late event failure and rejects revoked authority", async () => {
    const { env, db } = fixture();
    await configure(env);
    run(db);
    db.exec(
      "CREATE TRIGGER fail_usage BEFORE INSERT ON control_plane_events BEGIN SELECT RAISE(ABORT,'late'); END",
    );
    await expect(reserve(env)).rejects.toMatchObject({ code: "resource_admission_denied" });
    expect(db.prepare("SELECT COUNT(*) n FROM control_resource_reservations").get()!.n).toBe(0);
    db.exec("DROP TRIGGER fail_usage; UPDATE memberships SET status='revoked'");
    await expect(reserve(env)).rejects.toMatchObject({ code: "usage_scope_denied" });
  });
  it("executes a configured structured call once and replays only the validated recorded output", async () => {
    const { env, db } = fixture();
    await configure(env);
    run(db);
    const models = createRuntimeModelPort(env, identity, {
      runId: "run",
      signal: new AbortController().signal,
    });
    const result = await models.structured(request);
    expect(result.output).toEqual({ summary: "Observed evidence" });
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, source: "provider" });
    expect(await models.structured(request)).toEqual(result);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateText).mock.calls[0][0]).toMatchObject({
      maxRetries: 0,
      maxOutputTokens: 100,
    });
    await expect(models.structured({ ...request, prompt: "changed" })).rejects.toMatchObject({
      code: "usage_key_conflict",
    });
    expect(generateText).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid output while retaining provider usage and redacting the provider failure", async () => {
    const { env, db } = fixture();
    await configure(env);
    run(db);
    vi.mocked(generateText).mockResolvedValueOnce({
      output: { other: "secret" },
      usage: { inputTokens: 12, outputTokens: 8 },
    } as never);
    const models = createRuntimeModelPort(env, identity, {
      runId: "run",
      signal: new AbortController().signal,
    });
    await expect(models.structured(request)).rejects.toMatchObject({ code: "model_call_failed" });
    const stored = db
      .prepare(
        "SELECT input_tokens,output_tokens,status,result_json,error_code FROM control_resource_reservations",
      )
      .get();
    expect(stored).toMatchObject({
      input_tokens: 12,
      output_tokens: 8,
      status: "settled",
      result_json: null,
      error_code: "model_call_failed",
    });
    await expect(models.structured(request)).rejects.toMatchObject({ code: "model_call_failed" });
    expect(generateText).toHaveBeenCalledTimes(1);
  });
  it("holds charges after cancellation and never retries ambiguous calls", async () => {
    const { env, db } = fixture();
    await configure(env);
    run(db);
    const controller = new AbortController();
    vi.mocked(generateText).mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("provider-private-body");
    });
    const models = createRuntimeModelPort(env, identity, {
      runId: "run",
      signal: controller.signal,
    });
    await expect(models.structured(request)).rejects.toMatchObject({ code: "model_cancelled" });
    expect(
      db.prepare("SELECT status,error_code FROM control_resource_reservations").get(),
    ).toMatchObject({ status: "unknown", error_code: "model_cancelled" });
    await expect(
      createRuntimeModelPort(env, identity, {
        runId: "run",
        signal: new AbortController().signal,
      }).structured(request),
    ).rejects.toMatchObject({ code: "model_cancelled" });
    expect(generateText).toHaveBeenCalledTimes(1);
  });
  it("exports receipts, fences new admissions and purges usage through the lifecycle D1 phase", async () => {
    const { env, db } = fixture();
    await configure(env);
    run(db);
    await reserve(env);
    for (const name of [
      "control_resource_reservations",
      "control_budget_policies",
      "control_budget_changes",
    ])
      expect(
        await loadCollection(env, identity, exportCollections.find((item) => item.name === name)!),
      ).toHaveLength(1);
    db.exec(`INSERT INTO control_workspace_write_fences (workspace_id,job_id,status,lease_owner,lease_expires_at,acquired_at,updated_at)
      VALUES ('w','export','active','owner','2999-01-01T00:00:00Z','now','now')`);
    await expect(reserve(env, "two")).rejects.toMatchObject({
      code: "workspace_export_in_progress",
    });
    db.exec(`DELETE FROM control_workspace_write_fences; UPDATE workspaces SET status='purging',purge_after='2000-01-01T00:00:00Z';
      INSERT INTO control_data_jobs (id,user_id,workspace_id,kind,status,cursor_json,created_by_user_id,created_at,updated_at)
      VALUES ('purge','u','w','purge','running','{"phase":"objects_deleted"}','u','now','now')`);
    await purgeWorkspace(
      env,
      identity,
      db
        .prepare("SELECT * FROM control_data_jobs WHERE id='purge'")
        .get() as unknown as ControlDataJobRow,
    );
    for (const name of [
      "control_resource_reservations",
      "control_budget_policies",
      "control_budget_changes",
    ])
      expect(db.prepare(`SELECT COUNT(*) n FROM ${name}`).get()!.n).toBe(0);
  });
});
