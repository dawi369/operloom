import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentChatRunStartMirror, updateChatRun } from "./chat-boundary-store";
import {
  reserveChatCommand,
  acceptChatCommand,
  finishChatCommand,
  expireChatCommands,
  cancelThreadChatCommands,
  readChatCommand,
  handleGetChatCommand,
} from "./chat-command-admission";
import { createRuntimeClient } from "../../../packages/client/src/runtime-client";
import type { AgentIdentity, D1PreparedStatement, Env } from "./types";

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

const input = {
  threadId: "t",
  instanceName: "instance-t",
  turnId: "turn",
  payloadHash: "a".repeat(64),
};
const start = (env: Env, commandId: string, who = identity) =>
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
    commandId,
  });

describe("pending chat command admission", () => {
  it("preserves pending authority during export and expires running work after the fence is released", async () => {
    const { env, db, advance } = fixture();
    const command = await reserveChatCommand(env, identity, input);
    db.exec(`INSERT INTO control_workspace_write_fences
      (workspace_id,job_id,status,lease_owner,lease_expires_at,acquired_at,updated_at)
      VALUES ('w','export','active','exporter','9999-01-01T00:00:00.000Z','now','now');`);
    await expect(acceptChatCommand(env, identity, command)).rejects.toThrow(
      "workspace_export_in_progress",
    );
    await expect(finishChatCommand(env, command.id, "cancelled")).rejects.toThrow(
      "workspace_export_in_progress",
    );
    expect((await expireChatCommands(env, new Date("2100-01-01T00:00:00Z"))).inspected).toBe(0);
    expect((await readChatCommand(env, command.id))?.status).toBe("pending");
    db.exec("DELETE FROM control_workspace_write_fences");
    await acceptChatCommand(env, identity, command);
    const run = await start(env, command.id);
    await expireChatCommands(env, new Date("2100-01-01T00:00:00Z"));
    expect(await readChatCommand(env, command.id)).toMatchObject({
      status: "failed",
      error_code: "chat_command_timeout",
    });
    expect(db.prepare("SELECT status FROM chat_runs WHERE id = ?").get(run.runId)).toEqual({
      status: "failed",
    });
    expect(() => advance()).not.toThrow();
  });
  it("reserves idempotently before a run exists and serializes revision changes", async () => {
    const { env, db, advance } = fixture();
    const command = await reserveChatCommand(env, identity, input);
    expect(await reserveChatCommand(env, identity, input)).toEqual(command);
    expect(db.prepare("SELECT COUNT(*) AS count FROM chat_runs").get()).toEqual({ count: 0 });
    expect(() => advance()).toThrow("agent_runtime_revision_busy");
    await expect(
      reserveChatCommand(env, identity, { ...input, payloadHash: "b".repeat(64) }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      reserveChatCommand(env, identity, { ...input, turnId: "another" }),
    ).rejects.toMatchObject({ code: "chat_command_busy" });
    expect((await readChatCommand(env, command.id))?.status).toBe("pending");
    await finishChatCommand(env, command.id, "cancelled");
    advance();
    await expect(
      reserveChatCommand(env, identity, { ...input, turnId: "new" }),
    ).rejects.toMatchObject({ code: "chat_command_admission_denied" });
    await expect(
      reserveChatCommand(env, { ...identity, agentRevision: 1 }, { ...input, turnId: "new" }),
    ).resolves.toMatchObject({ agent_revision: 1 });
  });

  it("atomically transfers an accepted command to exactly one run and publishes durable outcomes", async () => {
    const { env, db, advance } = fixture();
    const command = await reserveChatCommand(env, identity, input);
    await expect(start(env, command.id)).rejects.toThrow("chat_command_conflict");
    expect(db.prepare("SELECT COUNT(*) AS count FROM runtime_traces").get()).toEqual({ count: 0 });
    await acceptChatCommand(env, identity, command);
    const run = await start(env, command.id);
    expect(await readChatCommand(env, command.id)).toMatchObject({
      status: "running",
      run_id: run.runId,
    });
    await updateChatRun(env, { scope: identity.scope, runId: run.runId, status: "completed" });
    expect(await readChatCommand(env, command.id)).toMatchObject({
      status: "completed",
      run_id: run.runId,
    });
    await expect(start(env, command.id)).rejects.toThrow("chat_command_conflict");
    await finishChatCommand(env, command.id, "failed", "late_error");
    expect((await readChatCommand(env, command.id))?.status).toBe("completed");
    const events = db
      .prepare(
        "SELECT data_json FROM control_plane_events WHERE type = 'chat.command.updated' ORDER BY rowid",
      )
      .all();
    expect(events.map((row) => JSON.parse(row.data_json as string).status)).toEqual([
      "pending",
      "running",
      "completed",
    ]);
    expect(() => advance()).not.toThrow();
  });

  it("rolls back run insertion, link and traces when the durable event cannot commit", async () => {
    const { env, db } = fixture();
    const command = await reserveChatCommand(env, identity, input);
    await acceptChatCommand(env, identity, command);
    db.exec(`CREATE TRIGGER event_failure BEFORE INSERT ON control_plane_events
      WHEN json_extract(NEW.data_json,'$.status') = 'running' BEGIN SELECT RAISE(ABORT,'event_failure'); END;`);
    await expect(start(env, command.id)).rejects.toThrow("event_failure");
    expect(await readChatCommand(env, command.id)).toMatchObject({
      status: "pending",
      run_id: null,
    });
    for (const table of [
      "chat_runs",
      "chat_intents",
      "chat_policy_decisions",
      "runtime_traces",
      "runtime_spans",
    ])
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({
        count: 0,
      });
  });

  it("expires abandoned acceptance without reopening its identity or admitting late work", async () => {
    const { env, db, advance } = fixture();
    const command = await reserveChatCommand(env, identity, input);
    await acceptChatCommand(env, identity, command);
    db.prepare("UPDATE control_chat_commands SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    // Admission checks the deadline even before a scheduler tick.
    await expect(start(env, command.id)).rejects.toThrow("chat_command_conflict");
    await expireChatCommands(env);
    expect(await readChatCommand(env, command.id)).toMatchObject({
      status: "failed",
      error_code: "chat_command_timeout",
    });
    expect(await reserveChatCommand(env, identity, input)).toMatchObject({
      id: command.id,
      status: "failed",
    });
    expect(() => db.exec("UPDATE control_chat_commands SET status = 'pending'")).toThrow(
      "chat_command_conflict",
    );
    await expect(start(env, command.id)).rejects.toThrow("chat_command_conflict");
    expect(() => advance()).not.toThrow();
  });

  it("closes running work and its command atomically on timeout or cancellation", async () => {
    const { env, db, advance } = fixture();
    const command = await reserveChatCommand(env, identity, input);
    await acceptChatCommand(env, identity, command);
    const run = await start(env, command.id);
    db.exec(`CREATE TRIGGER terminal_event_failure BEFORE INSERT ON control_plane_events
      WHEN json_extract(NEW.data_json,'$.status') = 'cancelled' BEGIN SELECT RAISE(ABORT,'event_failure'); END;`);
    await expect(cancelThreadChatCommands(env, input.instanceName)).rejects.toThrow(
      "event_failure",
    );
    expect((await readChatCommand(env, command.id))?.status).toBe("running");
    expect(db.prepare("SELECT status FROM chat_runs WHERE id = ?").get(run.runId)).toEqual({
      status: "running",
    });
    db.exec("DROP TRIGGER terminal_event_failure");
    await cancelThreadChatCommands(env, input.instanceName);
    expect((await readChatCommand(env, command.id))?.status).toBe("cancelled");
    expect(db.prepare("SELECT status FROM chat_runs WHERE id = ?").get(run.runId)).toEqual({
      status: "cancelled",
    });
    expect(() => advance()).not.toThrow();
  });

  it("rechecks live membership and scope at acceptance and run insertion", async () => {
    const { env, db } = fixture();
    const command = await reserveChatCommand(env, identity, input);
    db.exec("UPDATE memberships SET status = 'revoked'");
    await expect(acceptChatCommand(env, identity, command)).rejects.toMatchObject({
      code: "chat_command_closed",
    });
    db.exec("UPDATE memberships SET status = 'active'");
    await acceptChatCommand(env, identity, command);
    await expect(
      start(env, command.id, { ...identity, scope: { userId: "other", workspaceId: "w" } }),
    ).rejects.toThrow("chat_command_conflict");
    db.exec("UPDATE memberships SET status = 'revoked'");
    await expect(start(env, command.id)).rejects.toThrow("chat_command_conflict");
    expect((await readChatCommand(env, command.id))?.run_id).toBeNull();
  });

  it("observes command state through the Fetch contract and denies cross-scope reads", async () => {
    const { env, db } = fixture();
    const command = await reserveChatCommand(env, identity, input);
    const client = createRuntimeClient({
      baseUrl: "https://runtime.test",
      target: { workspaceId: "w", agentId: "a" },
      getAccessToken: async () => "fixture",
      fetch: async () => handleGetChatCommand(env, identity, command.id),
    });
    expect((await client.threads.command(command.id)).command).toMatchObject({
      id: command.id,
      status: "pending",
      acceptedAt: null,
      messageId: "turn",
    });
    expect(
      (await handleGetChatCommand(env, { ...identity, agentId: "other" }, command.id)).status,
    ).toBe(404);
    expect(
      (
        await handleGetChatCommand(
          env,
          { ...identity, scope: { userId: "other", workspaceId: "w" } },
          command.id,
        )
      ).status,
    ).toBe(404);
    db.exec("UPDATE workspaces SET status = 'quarantined'");
    await expect(client.threads.command(command.id)).rejects.toMatchObject({ status: 404 });
  });
});
