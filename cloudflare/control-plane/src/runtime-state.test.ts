import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeStateCommit, RuntimeStateDefinition } from "@operloom/agent-sdk";
import { createRuntimeStatePort } from "./runtime-state";
import { deliverRuntimeStateEvents } from "./runtime-state-outbox";
import {
  handleRuntimeStateOperation,
  handleRuntimeStateMigrationOperation,
} from "./runtime-state-api";
import * as runtimeRegistry from "../../../lib/agent-runtime/registry";
import { createRuntimeClient } from "../../../packages/workbench-client/src/runtime-client";
import {
  startRuntimeStateMigration,
  repairRuntimeStateMigration,
  advanceRuntimeStateMigration,
} from "./runtime-state-migrations";
import type { AgentIdentity, D1PreparedStatement, Env } from "./types";

const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});
const identity: AgentIdentity = { scope: { userId: "u", workspaceId: "w" }, agentId: "a" };
const definitions: RuntimeStateDefinition[] = [
  {
    namespace: "capacity",
    kind: "pool",
    schemaVersion: 1,
    indexes: [{ name: "remaining", field: "remaining" }],
    schema: {
      type: "object",
      properties: { remaining: { type: "integer", minimum: 0 } },
      required: ["remaining"],
      additionalProperties: false,
    },
  },
];
const fixture = async () => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec(`INSERT INTO users (id,status,created_at,updated_at) VALUES ('u','active','now','now');
    INSERT INTO workspaces (id,account_id,account_source,name,status,created_by_user_id,created_at,updated_at)
      VALUES ('w','acct','local','Workspace','active','u','now','now');
    INSERT INTO agents (id,workspace_id,name,status,created_by_user_id,created_at,updated_at)
      VALUES ('a','w','Agent','active','u','now','now');
    INSERT INTO memberships (id,user_id,workspace_id,role,status,created_at,updated_at)
      VALUES ('m','u','w','owner','active','now','now');`);
  db.prepare("UPDATE agents SET data_json = ?").run(
    JSON.stringify({
      behavior: {
        source: "template-snapshot",
        format: "xml",
        prompt: "Observe capacity.",
        pack: { id: "allocation", version: "1.0.0" },
      },
    }),
  );
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
            const result = db.prepare(query).run(...(values as never[]));
            return { success: true, meta: { changes: Number(result.changes) } };
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
  const port = await createRuntimeStatePort(env, identity, {
    packId: "allocation",
    target: "simulation",
    definitions,
  });
  return { db, env, port };
};
const key = { namespace: "capacity", kind: "pool", key: "main" };
const commit = (
  idempotencyKey: string,
  version: number,
  remaining: number,
): RuntimeStateCommit => ({
  idempotencyKey,
  reads: [{ ...key, version }],
  writes: [{ ...key, schemaVersion: 1, data: { remaining } }],
  entries: [{ id: `effect-${idempotencyKey}`, type: "effect", data: { allocated: 1 } }],
  events: [{ id: `event-${idempotencyKey}`, type: "capacity.changed", data: {} }],
});

describe("atomic runtime state", () => {
  it("fences ports captured before a runtime revision change and preserves state for the new revision", async () => {
    const { env, db, port } = await fixture();
    await port.commit(commit("before-upgrade", 0, 10));
    db.exec("UPDATE agents SET runtime_revision = 1");
    await expect(port.get(key)).rejects.toThrow("Current state authority is revoked");
    await expect(port.list({ namespace: key.namespace, kind: key.kind })).rejects.toThrow(
      "Current state authority is revoked",
    );
    await expect(port.commit(commit("after-upgrade", 1, 9))).rejects.toThrow();
    // Idempotent replay must not bypass the new authority boundary either.
    await expect(port.commit(commit("before-upgrade", 0, 10))).rejects.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM control_state_commits").get()).toEqual({
      count: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM control_state_entries").get()).toEqual({
      count: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM control_state_outbox").get()).toEqual({
      count: 1,
    });
    const current = await createRuntimeStatePort(
      env,
      { ...identity, agentRevision: 1 },
      {
        packId: "allocation",
        target: "simulation",
        definitions,
      },
    );
    expect(await current.get(key)).toMatchObject({ version: 1, data: { remaining: 10 } });
    await current.commit(commit("after-upgrade", 1, 9));
    expect(await current.get(key)).toMatchObject({ version: 2, data: { remaining: 9 } });
  });
  it("accepts repair through the Fetch contract using only a registered replacement", async () => {
    const { env, db } = await fixture();
    const defs = [definitions[0]!, { ...definitions[0]!, schemaVersion: 2 }];
    const migration = {
      id: "v2",
      namespace: "capacity",
      kind: "pool",
      fromVersion: 1,
      toVersion: 2,
      operations: [],
    };
    const replacement = { ...migration, id: "v2-repair" };
    const input = {
      packId: "allocation",
      target: "simulation" as const,
      agentSnapshot: db.prepare("SELECT data_json FROM agents").get()!.data_json as string,
    };
    await startRuntimeStateMigration(env, identity, { ...input, definitions: defs, migration });
    vi.spyOn(runtimeRegistry, "resolvePackRuntime").mockReturnValue({
      runnable: true,
      controlPlane: { state: defs, stateMigrations: [replacement] },
    } as unknown as ReturnType<typeof runtimeRegistry.resolvePackRuntime>);
    const client = createRuntimeClient({
      baseUrl: "https://runtime.test",
      target: { workspaceId: "w", agentId: "a" },
      getAccessToken: async () => "test-token",
      fetch: async (request, init) =>
        handleRuntimeStateMigrationOperation(
          new Request(request, init),
          env,
          identity,
          "v2",
          "repair",
        ),
    });
    const command = {
      target: "simulation" as const,
      expectedRevision: 0,
      replacementId: replacement.id,
      idempotencyKey: "repair-command",
    };
    await expect(
      client.state.repairMigration("v2", { ...command, replacementId: "unregistered" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      client.request("/workbench/state/migrations/v2/repair", {
        method: "POST",
        body: { ...command, operations: [] },
      }),
    ).rejects.toMatchObject({ status: 400 });
    const response = await client.state.repairMigration("v2", command);
    expect(response.migration).toMatchObject({ id: "v2", planId: replacement.id, revision: 1 });
    expect(await client.state.repairMigration("v2", command)).toEqual(response);
    db.exec("UPDATE memberships SET role='member'");
    await expect(client.state.repairMigration("v2", command)).rejects.toMatchObject({
      status: 403,
    });
  });
  it("serializes an advance racing a repair at the same revision", async () => {
    const { env, db } = await fixture();
    const defs = [definitions[0]!, { ...definitions[0]!, schemaVersion: 2 }];
    const migration = {
      id: "v2",
      namespace: "capacity",
      kind: "pool",
      fromVersion: 1,
      toVersion: 2,
      operations: [],
    };
    const input = {
      packId: "allocation",
      target: "simulation" as const,
      agentSnapshot: db.prepare("SELECT data_json FROM agents").get()!.data_json as string,
    };
    await startRuntimeStateMigration(env, identity, { ...input, definitions: defs, migration });
    const batch = env.DB.batch.bind(env.DB);
    let entered = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    env.DB.batch = async (statements) => {
      if (++entered === 2) release();
      await ready;
      return batch(statements);
    };
    const results = await Promise.allSettled([
      repairRuntimeStateMigration(env, identity, {
        ...input,
        migrationId: "v2",
        expectedRevision: 0,
        idempotencyKey: "repair",
        replacement: { ...migration, id: "v2-repair" },
        definitions: defs,
      }),
      advanceRuntimeStateMigration(env, identity, {
        ...input,
        migrationId: "v2",
        expectedRevision: 0,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "state_migration_conflict" },
    });
    expect(db.prepare("SELECT revision FROM control_state_migrations").get()!.revision).toBe(1);
  });
  it("repairs a failed migration suffix while preserving completed state and immutable receipts", async () => {
    const { env, db } = await fixture();
    const from: RuntimeStateDefinition = {
      ...definitions[0]!,
      schema: {
        type: "object",
        properties: { remaining: { type: "integer" }, available: { type: "integer" } },
        required: ["remaining"],
        additionalProperties: false,
      },
    };
    const to: RuntimeStateDefinition = {
      ...from,
      schemaVersion: 2,
      schema: {
        type: "object",
        properties: { available: { type: "integer" } },
        required: ["available"],
        additionalProperties: false,
      },
      indexes: [{ name: "available", field: "available" }],
    };
    const input = {
      packId: "allocation",
      target: "simulation" as const,
      agentSnapshot: db.prepare("SELECT data_json FROM agents").get()!.data_json as string,
    };
    const port = await createRuntimeStatePort(env, identity, { ...input, definitions: [from, to] });
    for (let i = 0; i < 20; i++) {
      const item = { ...key, key: `pool-${String(i).padStart(2, "0")}` };
      await port.commit({
        idempotencyKey: `seed-${i}`,
        reads: [{ ...item, version: 0 }],
        writes: [
          {
            ...item,
            schemaVersion: 1,
            data: { remaining: i, ...(i >= 16 ? { available: 999 } : {}) },
          },
        ],
      });
    }
    const migration = {
      id: "capacity-v2",
      namespace: "capacity",
      kind: "pool",
      fromVersion: 1,
      toVersion: 2,
      operations: [{ op: "rename" as const, from: "remaining", to: "available" }],
    };
    await startRuntimeStateMigration(env, identity, {
      ...input,
      definitions: [from, to],
      migration,
    });
    await advanceRuntimeStateMigration(env, identity, {
      ...input,
      migrationId: migration.id,
      expectedRevision: 0,
    });
    const advance = (expectedRevision: number) =>
      advanceRuntimeStateMigration(env, identity, {
        ...input,
        migrationId: migration.id,
        expectedRevision,
      });
    await expect(advance(1)).rejects.toMatchObject({ code: "state_migration_transform_invalid" });
    const prefix = await port.get({ ...key, key: "pool-00" });
    const replacement = {
      ...migration,
      id: "capacity-v2-repair",
      operations: [{ op: "remove" as const, field: "available" }, ...migration.operations],
    };
    const repairInput = {
      ...input,
      migrationId: migration.id,
      expectedRevision: 1,
      idempotencyKey: "repair-1",
      replacement,
      definitions: [from, to],
    };
    await expect(
      repairRuntimeStateMigration(env, identity, {
        ...repairInput,
        definitions: [from, { ...to, indexes: [] }],
      }),
    ).rejects.toMatchObject({ code: "state_migration_invalid" });
    db.exec(
      "INSERT INTO control_workspace_write_fences (workspace_id,job_id,status,lease_owner,lease_expires_at,acquired_at,updated_at) VALUES ('w','export','active','test','9999-01-01T00:00:00Z','now','now')",
    );
    await expect(repairRuntimeStateMigration(env, identity, repairInput)).rejects.toThrow(
      "workspace_export_in_progress",
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM control_state_migration_repairs").get()!.n).toBe(
      0,
    );
    db.exec("DELETE FROM control_workspace_write_fences");
    db.exec(
      "CREATE TRIGGER fail_repair_update BEFORE UPDATE ON control_state_migrations BEGIN SELECT RAISE(ABORT, 'repair_failure'); END",
    );
    await expect(repairRuntimeStateMigration(env, identity, repairInput)).rejects.toThrow(
      "repair_failure",
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM control_state_migration_repairs").get()!.n).toBe(
      0,
    );
    expect(db.prepare("SELECT revision FROM control_state_migrations").get()!.revision).toBe(1);
    db.exec("DROP TRIGGER fail_repair_update");
    const [repaired, duplicate] = await Promise.all([
      repairRuntimeStateMigration(env, identity, repairInput),
      repairRuntimeStateMigration(env, identity, repairInput),
    ]);
    expect(repaired).toEqual(duplicate);
    expect(repaired).toMatchObject({
      id: migration.id,
      planId: replacement.id,
      revision: 2,
      processed: 16,
      status: "running",
    });
    await expect(advance(1)).rejects.toMatchObject({ code: "state_migration_conflict" });
    await expect(
      port.commit({
        idempotencyKey: "still-fenced",
        reads: [{ ...key, version: 0 }],
        writes: [{ ...key, schemaVersion: 2, data: { available: 1 } }],
      }),
    ).rejects.toMatchObject({ code: "state_conflict" });
    expect(await advance(2)).toMatchObject({ status: "completed", revision: 3, processed: 20 });
    expect(await port.get({ ...key, key: "pool-00" })).toEqual(prefix);
    expect(await port.get({ ...key, key: "pool-19" })).toMatchObject({
      version: 2,
      schemaVersion: 2,
      data: { available: 19 },
    });
    expect(await repairRuntimeStateMigration(env, identity, repairInput)).toEqual(repaired);
    expect(
      await startRuntimeStateMigration(env, identity, {
        ...input,
        definitions: [from, to],
        migration,
      }),
    ).toMatchObject({ status: "completed", planId: replacement.id, revision: 3 });
    await expect(
      repairRuntimeStateMigration(env, identity, { ...repairInput, expectedRevision: 3 }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const history = db
      .prepare(
        "SELECT previous_plan_json,replacement_plan_json FROM control_state_migration_repairs",
      )
      .get()!;
    expect(JSON.parse(history.previous_plan_json as string).migration.id).toBe(migration.id);
    expect(JSON.parse(history.replacement_plan_json as string).migration.id).toBe(replacement.id);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM control_plane_events WHERE type='state.migration_repaired'",
        )
        .get()!.n,
    ).toBe(1);
  });
  it("rejects a repair whose admin authority changes before its transaction", async () => {
    const { env, db } = await fixture();
    const defs = [definitions[0]!, { ...definitions[0]!, schemaVersion: 2 }];
    const input = {
      packId: "allocation",
      target: "simulation" as const,
      agentSnapshot: db.prepare("SELECT data_json FROM agents").get()!.data_json as string,
    };
    const migration = {
      id: "v2",
      namespace: "capacity",
      kind: "pool",
      fromVersion: 1,
      toVersion: 2,
      operations: [],
    };
    await startRuntimeStateMigration(env, identity, { ...input, definitions: defs, migration });
    const batch = env.DB.batch.bind(env.DB);
    env.DB.batch = async (statements) => {
      db.exec("UPDATE memberships SET role='member'");
      return batch(statements);
    };
    await expect(
      repairRuntimeStateMigration(env, identity, {
        ...input,
        migrationId: "v2",
        expectedRevision: 0,
        idempotencyKey: "repair",
        replacement: { ...migration, id: "v2-repair" },
        definitions: defs,
      }),
    ).rejects.toMatchObject({ code: "state_migration_conflict" });
    expect(db.prepare("SELECT revision FROM control_state_migrations").get()!.revision).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM control_state_migration_repairs").get()!.n).toBe(
      0,
    );
  });
  it("resumes bounded schema migrations with stable receipts, rebuilt indexes and writer fencing", async () => {
    const { port, env, db } = await fixture();
    for (let i = 0; i < 20; i++) {
      const item = { ...key, key: `pool-${String(i).padStart(2, "0")}` };
      await port.commit({
        idempotencyKey: `seed-${i}`,
        reads: [{ ...item, version: 0 }],
        writes: [{ ...item, schemaVersion: 1, data: { remaining: i } }],
      });
    }
    const next: RuntimeStateDefinition = {
      ...definitions[0]!,
      schemaVersion: 2,
      schema: {
        type: "object",
        properties: { available: { type: "integer", minimum: 0 } },
        required: ["available"],
        additionalProperties: false,
      },
      indexes: [{ name: "available", field: "available" }],
    };
    const migration = {
      id: "capacity-v2",
      namespace: "capacity",
      kind: "pool",
      fromVersion: 1,
      toVersion: 2,
      operations: [{ op: "rename" as const, from: "remaining", to: "available" }],
    };
    const input = {
      packId: "allocation",
      target: "simulation" as const,
      agentSnapshot: db.prepare("SELECT data_json FROM agents").get()!.data_json as string,
    };
    const start = await startRuntimeStateMigration(env, identity, {
      ...input,
      definitions: [...definitions, next],
      migration,
    });
    expect(start).toMatchObject({ status: "running", revision: 0 });
    await expect(port.commit(commit("blocked", 0, 10))).rejects.toMatchObject({
      code: "state_conflict",
    });
    expect((await port.list({ namespace: "capacity", kind: "pool" })).records).toHaveLength(20);
    const [first, duplicate] = await Promise.all(
      [0, 0].map((expectedRevision) =>
        advanceRuntimeStateMigration(env, identity, {
          ...input,
          migrationId: migration.id,
          expectedRevision,
        }),
      ),
    );
    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({ status: "running", revision: 1, processed: 16 });
    // Recreate the port as a restarted request would; old records remain readable mid-migration.
    const restarted = await createRuntimeStatePort(env, identity, {
      ...input,
      definitions: [...definitions, next],
    });
    const mixed = (await restarted.list({ namespace: "capacity", kind: "pool" })).records;
    expect(new Set(mixed.map((record) => record.schemaVersion))).toEqual(new Set([1, 2]));
    expect(
      await advanceRuntimeStateMigration(env, identity, {
        ...input,
        migrationId: migration.id,
        expectedRevision: 1,
      }),
    ).toMatchObject({ status: "completed", revision: 2, processed: 20 });
    expect(
      await advanceRuntimeStateMigration(env, identity, {
        ...input,
        migrationId: migration.id,
        expectedRevision: 0,
      }),
    ).toEqual(first);
    expect(
      (
        await restarted.list({
          namespace: "capacity",
          kind: "pool",
          index: { name: "available", value: 19 },
        })
      ).records[0]?.data,
    ).toEqual({ available: 19 });
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM control_state_indexes WHERE index_name = 'remaining'",
        )
        .get()!.count,
    ).toBe(0);
    await expect(port.commit(commit("old-writer", 0, 1))).rejects.toMatchObject({
      code: "state_conflict",
    });
    await restarted.commit({
      idempotencyKey: "new-writer",
      reads: [{ ...key, version: 0 }],
      writes: [{ ...key, schemaVersion: 2, data: { available: 1 } }],
    });
    await expect(
      startRuntimeStateMigration(env, identity, {
        ...input,
        definitions: [...definitions, next],
        migration: { ...migration, operations: [] },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("rolls back migration records, cursor and receipts on late failure or revoked authority", async () => {
    const { port, env, db } = await fixture();
    await port.commit(commit("source", 0, 5));
    const next = { ...definitions[0]!, schemaVersion: 2 };
    const migration = {
      id: "reindex",
      namespace: "capacity",
      kind: "pool",
      fromVersion: 1,
      toVersion: 2,
      operations: [],
    };
    const input = {
      packId: "allocation",
      target: "simulation" as const,
      agentSnapshot: db.prepare("SELECT data_json FROM agents").get()!.data_json as string,
    };
    await startRuntimeStateMigration(env, identity, {
      ...input,
      definitions: [...definitions, next],
      migration,
    });
    db.exec(
      "CREATE TRIGGER fail_migration_progress BEFORE UPDATE ON control_state_migrations BEGIN SELECT RAISE(ABORT, 'test_failure'); END",
    );
    const advance = () =>
      advanceRuntimeStateMigration(env, identity, {
        ...input,
        migrationId: migration.id,
        expectedRevision: 0,
      });
    await expect(advance()).rejects.toThrow("test_failure");
    expect((await port.get(key))?.schemaVersion).toBe(1);
    expect(db.prepare("SELECT revision FROM control_state_migrations").get()!.revision).toBe(0);
    expect(
      db.prepare("SELECT count(*) AS count FROM control_state_migration_steps").get()!.count,
    ).toBe(0);
    db.exec("DROP TRIGGER fail_migration_progress");
    const batch = env.DB.batch.bind(env.DB);
    env.DB.batch = async (statements) => {
      db.exec("UPDATE memberships SET status = 'disabled'");
      return batch(statements);
    };
    await expect(advance()).rejects.toMatchObject({ code: "state_migration_conflict" });
    expect(
      db.prepare("SELECT schema_version FROM control_state_records").get()!.schema_version,
    ).toBe(1);
    env.DB.batch = batch;
    db.exec("UPDATE memberships SET status = 'active'");
    db.exec(
      "INSERT INTO control_workspace_write_fences (workspace_id,job_id,status,lease_owner,lease_expires_at,acquired_at,updated_at) VALUES ('w','export','active','test','9999-01-01T00:00:00Z','now','now')",
    );
    await expect(advance()).rejects.toThrow("workspace_export_in_progress");
    db.exec("DELETE FROM control_workspace_write_fences");
    expect(await advance()).toMatchObject({ status: "completed", processed: 1 });
  });
  it("exposes bounded records and immutable evidence with target-bound cursors", async () => {
    const { port, env } = await fixture();
    await port.commit(commit("first", 0, 5));
    const second = commit("second", 1, 4);
    await port.commit(second);
    const read = (resource: "records" | "entries" | "deliveries", query: string) =>
      handleRuntimeStateOperation(
        new Request(`https://runtime.test/workbench/state/${resource}?${query}`),
        env,
        identity,
        resource,
      );
    const records = await (
      await read("records", "target=simulation&namespace=capacity&kind=pool")
    ).json();
    expect(records).toMatchObject({
      ok: true,
      records: [{ key: "main", version: 2, data: { remaining: 4 } }],
    });
    const first = (await (await read("entries", "target=simulation&limit=1")).json()) as {
      entries: { key: string }[];
      nextCursor: string;
    };
    expect(first.entries[0]?.key).toBe("effect-first");
    expect(
      await (
        await read(
          "entries",
          `target=simulation&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
        )
      ).json(),
    ).toMatchObject({ entries: [{ key: "effect-second" }] });
    expect(
      (await read("entries", `target=external&cursor=${encodeURIComponent(first.nextCursor)}`))
        .status,
    ).toBe(400);
    expect(await (await read("entries", "target=external")).json()).toMatchObject({ entries: [] });
    expect((await read("entries", "target=simulation&scopeId=forged")).status).toBe(400);
    expect((await read("entries", "target=simulation&target=external")).status).toBe(400);
    expect((await read("entries", "target=simulation&limit=101")).status).toBe(400);
    const other = await handleRuntimeStateOperation(
      new Request("https://runtime.test/?target=simulation"),
      env,
      { ...identity, scope: { ...identity.scope, userId: "other" } },
      "entries",
    );
    expect(other.status).toBe(403);
  });
  it("atomically audits admin retry, fences exports, and rejects delayed or concurrent duplicates", async () => {
    const { port, env, db } = await fixture();
    await port.commit(commit("retry", 0, 5));
    db.exec("UPDATE control_state_outbox SET status = 'failed', attempts = 8");
    const deliveryId = db.prepare("SELECT id FROM control_state_outbox").get()!.id as string;
    const retry = (expectedAttempts = 8) =>
      handleRuntimeStateOperation(
        new Request("https://runtime.test/", {
          method: "POST",
          body: JSON.stringify({ target: "simulation", expectedAttempts }),
        }),
        env,
        identity,
        "deliveries",
        deliveryId,
      );
    db.exec("UPDATE memberships SET role = 'member'");
    expect((await retry()).status).toBe(403);
    db.exec("UPDATE memberships SET role = 'admin'");
    db.exec(
      "INSERT INTO control_workspace_write_fences (workspace_id,job_id,status,lease_owner,lease_expires_at,acquired_at,updated_at) VALUES ('w','export','active','test','9999-01-01T00:00:00Z','now','now')",
    );
    expect((await retry()).status).toBe(409);
    expect(db.prepare("SELECT count(*) AS count FROM control_plane_events").get()!.count).toBe(0);
    expect(db.prepare("SELECT status FROM control_state_outbox").get()!.status).toBe("failed");
    db.exec("DELETE FROM control_workspace_write_fences");
    const results = await Promise.all([retry(), retry()]);
    expect(results.map((result) => result.status).sort()).toEqual([202, 409]);
    expect(db.prepare("SELECT count(*) AS count FROM control_plane_events").get()!.count).toBe(1);
    // A later failure increments rather than resets attempts, fencing a delayed old command.
    db.exec("UPDATE control_state_outbox SET status = 'failed', attempts = 9");
    expect((await retry()).status).toBe(409);
    expect((await retry(9)).status).toBe(202);
    await deliverRuntimeStateEvents(env);
    expect(db.prepare("SELECT status, attempts FROM control_state_outbox").get()).toMatchObject({
      status: "delivered",
      attempts: 10,
    });
    expect((await retry(10)).status).toBe(409);
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM control_plane_events WHERE type = 'capacity.changed'",
        )
        .get()!.count,
    ).toBe(1);
  });
  it("rechecks retry authority inside the transaction after membership revocation", async () => {
    const { port, env, db } = await fixture();
    await port.commit(commit("revocation", 0, 5));
    db.exec("UPDATE control_state_outbox SET status = 'failed', attempts = 8");
    const deliveryId = db.prepare("SELECT id FROM control_state_outbox").get()!.id as string;
    const batch = env.DB.batch.bind(env.DB);
    env.DB.batch = async (statements) => {
      db.exec("UPDATE memberships SET status = 'disabled'");
      return batch(statements);
    };
    const response = await handleRuntimeStateOperation(
      new Request("https://runtime.test/", {
        method: "POST",
        body: JSON.stringify({ target: "simulation", expectedAttempts: 8 }),
      }),
      env,
      identity,
      "deliveries",
      deliveryId,
    );
    expect(response.status).toBe(409);
    expect(db.prepare("SELECT status FROM control_state_outbox").get()!.status).toBe("failed");
    expect(db.prepare("SELECT count(*) AS count FROM control_plane_events").get()!.count).toBe(0);
  });
  it("publishes committed intents once and rolls back publication if acknowledgement fails", async () => {
    const { port, env, db } = await fixture();
    await port.commit(commit("publish", 0, 5));
    db.exec(
      `CREATE TRIGGER fail_outbox_ack BEFORE UPDATE ON control_state_outbox BEGIN SELECT RAISE(ABORT, 'test_failure'); END;`,
    );
    expect((await deliverRuntimeStateEvents(env)).deferred).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM control_plane_events").get()?.count).toBe(0);
    db.exec("DROP TRIGGER fail_outbox_ack");
    await deliverRuntimeStateEvents(env);
    await deliverRuntimeStateEvents(env);
    expect(db.prepare("SELECT COUNT(*) AS count FROM control_plane_events").get()?.count).toBe(1);
    expect(db.prepare("SELECT status FROM control_state_outbox").get()?.status).toBe("delivered");
  });
  it("holds pending state events while membership is revoked and delivers on recovery", async () => {
    const { port, env, db } = await fixture();
    await port.commit(commit("revoked", 0, 5));
    db.exec("UPDATE memberships SET status = 'disabled'");
    await deliverRuntimeStateEvents(env);
    expect(db.prepare("SELECT COUNT(*) AS count FROM control_plane_events").get()?.count).toBe(0);
    db.exec("UPDATE memberships SET status = 'active'");
    await deliverRuntimeStateEvents(env);
    expect(db.prepare("SELECT COUNT(*) AS count FROM control_plane_events").get()?.count).toBe(1);
  });
  it("pages declared indexes, binds cursors to queries, and fences incompatible schema writers", async () => {
    const { port, env } = await fixture();
    await port.commit(commit("first", 0, 10));
    const second = commit("second", 0, 10);
    second.reads = [{ ...key, key: "second", version: 0 }];
    second.writes = [{ ...key, key: "second", schemaVersion: 1, data: { remaining: 10 } }];
    await port.commit(second);
    const query = {
      namespace: key.namespace,
      kind: key.kind,
      limit: 1,
      index: { name: "remaining", value: 10 },
    };
    const page = await port.list(query);
    expect(page.records.map((record) => record.key)).toEqual(["main"]);
    expect(page.nextCursor).toBeTruthy();
    expect(
      (await port.list({ ...query, cursor: page.nextCursor })).records.map((record) => record.key),
    ).toEqual(["second"]);
    await expect(
      port.list({ ...query, cursor: page.nextCursor, index: { name: "remaining", value: 9 } }),
    ).rejects.toMatchObject({ code: "state_cursor_invalid" });
    const upgraded = await createRuntimeStatePort(env, identity, {
      packId: "allocation",
      target: "simulation",
      definitions: [...definitions, { ...definitions[0]!, schemaVersion: 2 }],
    });
    expect(await upgraded.get(key)).toMatchObject({ version: 1, schemaVersion: 1 });
    const incompatible = commit("schema-upgrade", 1, 9);
    incompatible.writes = [{ ...key, schemaVersion: 2, data: { remaining: 9 } }];
    await expect(upgraded.commit(incompatible)).rejects.toMatchObject({ code: "state_conflict" });
  });
  it("commits records, immutable effects and delivery intents once; replay returns the original receipt", async () => {
    const { port, db } = await fixture();
    const operation = commit("create", 0, 10);
    const first = await port.commit(operation);
    expect(await port.commit(operation)).toEqual(first);
    expect(await port.get(key)).toMatchObject({ version: 1, data: { remaining: 10 } });
    for (const table of ["control_state_commits", "control_state_entries", "control_state_outbox"])
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(1);
    await expect(port.commit(commit("create", 0, 9))).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
  });
  it("aborts every write and effect when any read version is stale", async () => {
    const { port, db } = await fixture();
    await port.commit(commit("create", 0, 10));
    const operation = commit("stale", 0, 9);
    operation.reads = [...operation.reads, { ...key, key: "second", version: 0 }];
    operation.writes = [
      ...operation.writes,
      { ...key, key: "second", schemaVersion: 1, data: { remaining: 50 } },
    ];
    await expect(port.commit(operation)).rejects.toMatchObject({ code: "state_conflict" });
    expect(await port.get(key)).toMatchObject({ version: 1, data: { remaining: 10 } });
    expect(await port.get({ ...key, key: "second" })).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM control_state_entries").get()?.n).toBe(1);
  });
  it("allows only one concurrent allocation at the same observed version", async () => {
    const { port } = await fixture();
    await port.commit(commit("create", 0, 10));
    const results = await Promise.allSettled([
      port.commit(commit("one", 1, 9)),
      port.commit(commit("two", 1, 9)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await port.get(key)).toMatchObject({ version: 2, data: { remaining: 9 } });
  });
  it("rolls back earlier writes when a later immutable entry fails", async () => {
    const { port } = await fixture();
    await port.commit(commit("create", 0, 10));
    const operation = commit("duplicate-evidence", 1, 9);
    operation.entries = [{ id: "effect-create", type: "effect", data: {} }];
    await expect(port.commit(operation)).rejects.toThrow();
    expect(await port.get(key)).toMatchObject({ version: 1, data: { remaining: 10 } });
  });
  it("fences export and revocation, isolates target and agent scopes, and rejects undeclared records", async () => {
    const { port, env, db } = await fixture();
    await port.commit(commit("create", 0, 10));
    const external = await createRuntimeStatePort(env, identity, {
      packId: "allocation",
      target: "external",
      definitions,
    });
    expect(await external.get(key)).toBeNull();
    const unrelated = await createRuntimeStatePort(
      env,
      { ...identity, agentId: "other" },
      { packId: "allocation", target: "simulation", definitions },
    );
    await expect(unrelated.get(key)).rejects.toMatchObject({ code: "state_scope_denied" });
    await expect(port.get({ ...key, namespace: "private" })).rejects.toMatchObject({
      code: "state_scope_denied",
    });
    db.exec(
      "INSERT INTO control_workspace_write_fences (workspace_id,job_id,status,lease_owner,lease_expires_at,acquired_at,updated_at) VALUES ('w','export','active','test','2999-01-01T00:00:00.000Z','now','now')",
    );
    await expect(port.commit(commit("export-write", 1, 9))).rejects.toThrow(
      "workspace_export_in_progress",
    );
    db.exec(
      "DELETE FROM control_workspace_write_fences; UPDATE memberships SET status = 'revoked'",
    );
    await expect(port.commit(commit("revoked-write", 1, 9))).rejects.toMatchObject({
      code: "state_conflict",
    });
  });
});
