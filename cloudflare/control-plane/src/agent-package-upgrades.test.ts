import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAgentPackageUpgrade, handleAgentPackageSnapshots } from "./agent-package-upgrades";
import {
  createAgentBehaviorSnapshotFromTemplate,
  toPackTemplate,
} from "./agent-behavior-templates";
import { agentManifestRegistry } from "../../../generated/agent-runtime/manifests";
import * as registry from "../../../lib/agent-runtime/registry";
import { createRuntimeStatePort } from "./runtime-state";
import { reserveChatCommand } from "./chat-command-admission";
import { createRuntimeClient } from "../../../packages/workbench-client/src/runtime-client";
import { purgeWorkspace } from "./workspace-data-jobs";
import { exportCollections, loadCollection } from "./workspace-data-export-core";
import type { AgentIdentity, ControlDataJobRow, D1PreparedStatement, Env } from "./types";
const manifest = agentManifestRegistry["complex-operator"].module;
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
  env.WORKBENCH_PACKAGE_UPGRADES_ENABLED = "true";
  env.WORKBENCH_TYPED_STATE_ENABLED = "true";
  env.WORKBENCH_CONFORMANCE_MODE = "true";
  const current = createAgentBehaviorSnapshotFromTemplate(toPackTemplate(manifest));
  const old = { ...current, version: "0.0.1", pack: { ...current.pack!, version: "0.0.1" } };
  db.prepare("UPDATE agents SET data_json = ? WHERE id = 'a'").run(
    JSON.stringify({ profile: "operator", custom: { retained: true }, behavior: old }),
  );
  return { db, env, old };
};

const input = {
  targetVersion: manifest.version,
  expectedRevision: 0,
  idempotencyKey: "upgrade-key",
};
const upgrade = (env: Env, body: unknown = input, who = identity) =>
  handleAgentPackageUpgrade(
    new Request("https://api/workbench/package-upgrades", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    env,
    who,
  );
const history = (env: Env, who = identity) =>
  handleAgentPackageSnapshots(new Request("https://api/workbench/package-snapshots"), env, who);
const counts = (db: DatabaseSync) =>
  Object.fromEntries(
    [
      "control_agent_snapshots",
      "control_agent_upgrades",
      "control_plane_events",
      "control_audit_events",
    ].map((table) => [table, db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n]),
  );
const definition = {
  namespace: "capacity",
  kind: "pool",
  schemaVersion: 1,
  schema: {
    type: "object",
    required: ["remaining"],
    properties: { remaining: { type: "integer", minimum: 0 } },
    additionalProperties: false,
  },
  indexes: [{ name: "remaining", field: "remaining" }],
} as const;
const withState = () => {
  const actual = registry.resolvePackRuntime(manifest.id, manifest.version);
  if (!actual.runnable) throw new Error("fixture runtime");
  vi.spyOn(registry, "resolvePackRuntime").mockReturnValue({
    ...actual,
    controlPlane: { ...actual.controlPlane, state: [definition] },
  });
};
const seedState = async (
  env: Env,
  target: "simulation" | "external" = "simulation",
  who = identity,
) => {
  const state = await createRuntimeStatePort(env, who, {
    packId: manifest.id,
    target,
    definitions: [definition],
  });
  await state.commit({
    idempotencyKey: "initial",
    reads: [{ namespace: "capacity", kind: "pool", key: "one", version: 0 }],
    writes: [
      { namespace: "capacity", kind: "pool", key: "one", schemaVersion: 1, data: { remaining: 7 } },
    ],
  });
  return state;
};

describe("explicit package upgrades", () => {
  it("exports exact history and purges it through the lifecycle D1 phase", async () => {
    const { env, db } = fixture();
    expect((await upgrade(env)).status).toBe(200);
    const collection = exportCollections.find((item) => item.name === "control_agent_snapshots")!;
    expect((await loadCollection(env, identity, collection)).length).toBe(2);
    db.exec(`UPDATE workspaces SET status = 'purging', purge_after = '2000-01-01T00:00:00Z';
      INSERT INTO control_data_jobs (id,user_id,workspace_id,kind,status,cursor_json,created_by_user_id,created_at,updated_at)
      VALUES ('purge','u','w','purge','running','{"phase":"objects_deleted"}','u','now','now')`);
    const job = db
      .prepare("SELECT * FROM control_data_jobs WHERE id = 'purge'")
      .get() as unknown as ControlDataJobRow;
    await purgeWorkspace(env, identity, job);
    expect(counts(db).control_agent_snapshots).toBe(0);
    expect(counts(db).control_agent_upgrades).toBe(0);
    expect(db.prepare("SELECT count(*) n FROM control_deletion_receipts").get()!.n).toBe(1);
  });

  it("blocks missing handlers, incompatible triggers and accepted trigger dispatches", async () => {
    const { env, db } = fixture();
    expect((await upgrade(env, { ...input, targetVersion: "not-installed" })).status).toBe(422);
    db.exec(`INSERT INTO control_trigger_dispatches (id,trigger_id,user_id,workspace_id,agent_id,idempotency_key,source,status,received_at,created_at,updated_at)
      VALUES ('dispatch','trigger','u','w','a','event','webhook','pending','now','now','now')`);
    expect(await (await upgrade(env)).json()).toMatchObject({
      code: "agent_runtime_revision_busy",
    });
    db.exec(`UPDATE control_trigger_dispatches SET status = 'completed';
      INSERT INTO control_triggers (id,user_id,workspace_id,agent_id,pack_id,pack_trigger_id,kind,workflow_type,status,execution_json,config_json,max_concurrent_runs,created_by_user_id,created_at,updated_at)
      VALUES ('trigger','u','w','a','complex-operator','test','schedule','removed.workflow','disabled','{}','{}',1,'u','now','now')`);
    expect(await (await upgrade(env)).json()).toMatchObject({
      code: "agent_upgrade_trigger_incompatible",
    });
    expect(counts(db).control_agent_upgrades).toBe(0);
  });

  it("fails closed on disabled upgrades and concurrent different keys", async () => {
    const { env, db } = fixture();
    env.WORKBENCH_PACKAGE_UPGRADES_ENABLED = "false";
    expect((await upgrade(env)).status).toBe(404);
    env.WORKBENCH_PACKAGE_UPGRADES_ENABLED = "true";
    const results = await Promise.all([
      upgrade(env),
      upgrade(env, { ...input, idempotencyKey: "other" }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(counts(db).control_agent_upgrades).toBe(1);
    db.exec("UPDATE agents SET runtime_revision = 2");
    expect(await (await upgrade(env)).json()).toMatchObject({
      upgrade: { fromRevision: 0, toRevision: 1 },
    });
  });

  it("archives exact snapshots, keeps identities/configuration, replays original receipt and publishes once", async () => {
    const { env, db, old } = fixture();
    const response = await upgrade(env);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.upgrade).toMatchObject({
      agentId: "a",
      packId: manifest.id,
      fromVersion: "0.0.1",
      toVersion: manifest.version,
      fromRevision: 0,
      toRevision: 1,
    });
    expect(await (await upgrade(env)).json()).toEqual(result);
    expect((await upgrade(env, { ...input, targetVersion: "changed" })).status).toBe(409);
    expect((await upgrade(env, { ...input, idempotencyKey: "new" })).status).toBe(409);
    expect(counts(db)).toEqual({
      control_agent_snapshots: 2,
      control_agent_upgrades: 1,
      control_plane_events: 1,
      control_audit_events: 1,
    });
    const saved = await (await history(env)).json();
    expect(saved.currentRevision).toBe(1);
    expect(saved.snapshots[1].snapshot.behavior).toEqual(old);
    expect(saved.snapshots[0].snapshot.custom).toEqual({ retained: true });
    expect(db.prepare("SELECT thread_id, agent_id FROM chat_threads").get()).toEqual({
      thread_id: "t",
      agent_id: "a",
    });
    expect(() => db.exec("UPDATE control_agent_snapshots SET snapshot_json = '{}' ")).toThrow(
      "agent_upgrade_history_immutable",
    );
    expect(() => db.exec("UPDATE control_agent_upgrades SET receipt_json = '{}' ")).toThrow(
      "agent_upgrade_history_immutable",
    );
    for (const table of ["control_agent_snapshots", "control_agent_upgrades"])
      expect(exportCollections.some((item) => item.name === table)).toBe(true);
  });

  it("keeps both state targets and invalidates old handles after upgrade", async () => {
    withState();
    const { env, db } = fixture();
    const old = await seedState(env);
    await seedState(env, "external");
    const before = db.prepare("SELECT * FROM control_state_records ORDER BY id").all();
    expect((await upgrade(env)).status).toBe(200);
    expect(db.prepare("SELECT * FROM control_state_records ORDER BY id").all()).toEqual(before);
    await expect(
      old.get({ namespace: "capacity", kind: "pool", key: "one" }),
    ).rejects.toMatchObject({ code: "state_scope_denied" });
    const fresh = await createRuntimeStatePort(
      env,
      { ...identity, agentRevision: 1 },
      { packId: manifest.id, target: "simulation", definitions: [definition] },
    );
    expect(await fresh.get({ namespace: "capacity", kind: "pool", key: "one" })).toMatchObject({
      data: { remaining: 7 },
      version: 1,
    });
  });

  it("rejects incompatible records or indexes in any user's state", async () => {
    withState();
    const { env, db } = fixture();
    db.exec(
      "INSERT INTO users (id,status,created_at,updated_at) VALUES ('other','active','now','now'); INSERT INTO memberships(id,user_id,workspace_id,role,status,created_at,updated_at) VALUES ('other-member','other','w','member','active','now','now')",
    );
    await seedState(env, "external", {
      scope: { userId: "other", workspaceId: "w" },
      agentId: "a",
    });
    db.exec("UPDATE control_state_records SET data_json = '{\"remaining\":-1}'");
    expect(await (await upgrade(env)).json()).toMatchObject({
      code: "agent_upgrade_state_incompatible",
    });
    db.exec(
      "UPDATE control_state_records SET data_json = '{\"remaining\":7}'; DELETE FROM control_state_indexes",
    );
    expect(await (await upgrade(env)).json()).toMatchObject({
      code: "agent_upgrade_indexes_incompatible",
    });
    expect(db.prepare("SELECT runtime_revision FROM agents").get()!.runtime_revision).toBe(0);
    expect(counts(db).control_agent_upgrades).toBe(0);
  });

  it("rolls back the whole upgrade on late audit failure and retries safely", async () => {
    const { env, db } = fixture();
    const before = db.prepare("SELECT * FROM agents").get();
    db.exec(
      "CREATE TRIGGER fail_upgrade_event BEFORE INSERT ON control_plane_events BEGIN SELECT RAISE(ABORT, 'test_failure'); END;",
    );
    expect((await upgrade(env)).status).toBe(500);
    expect(db.prepare("SELECT * FROM agents").get()).toEqual(before);
    expect(Object.values(counts(db))).toEqual([0, 0, 0, 0]);
    db.exec("DROP TRIGGER fail_upgrade_event");
    expect((await upgrade(env)).status).toBe(200);
  });

  it("rejects changes or authority revocation between validation and commit", async () => {
    withState();
    const { env, db } = fixture();
    await seedState(env);
    const batch = env.DB.batch.bind(env.DB);
    let mode = "write";
    env.DB.batch = async (statements) => {
      if (mode === "write") db.exec("UPDATE control_state_records SET version = version + 1");
      else db.exec("UPDATE memberships SET status = 'revoked'");
      return batch(statements);
    };
    expect(await (await upgrade(env)).json()).toMatchObject({ code: "agent_upgrade_conflict" });
    mode = "revoke";
    expect(await (await upgrade(env)).json()).toMatchObject({ code: "agent_upgrade_conflict" });
    expect(counts(db).control_agent_snapshots).toBe(0);
  });

  it("blocks pending work and export fences without leaving receipts", async () => {
    const { env, db } = fixture();
    await reserveChatCommand(env, identity, {
      threadId: "t",
      instanceName: "i",
      turnId: "turn",
      payloadHash: "a".repeat(64),
    });
    expect(await (await upgrade(env)).json()).toMatchObject({
      code: "agent_runtime_revision_busy",
    });
    db.exec("UPDATE control_chat_commands SET status = 'cancelled'");
    db.exec(`INSERT INTO control_workspace_write_fences (workspace_id,job_id,status,lease_owner,lease_expires_at,acquired_at,updated_at)
      VALUES ('w','export','active','exporter','9999-01-01T00:00:00.000Z','now','now')`);
    expect(await (await upgrade(env)).json()).toMatchObject({
      code: "workspace_export_in_progress",
    });
    expect(counts(db).control_agent_upgrades).toBe(0);
  });

  it("rechecks replay authority, quarantine and explicit tenant targets", async () => {
    const { env, db } = fixture();
    expect((await upgrade(env)).status).toBe(200);
    expect(
      (await history(env, { ...identity, scope: { userId: "u", workspaceId: "elsewhere" } }))
        .status,
    ).toBe(403);
    db.exec("UPDATE workspaces SET status = 'quarantined'");
    expect((await upgrade(env)).status).toBe(403);
    expect((await history(env)).status).toBe(403);
    db.exec("UPDATE workspaces SET status = 'active'; UPDATE memberships SET role = 'member'");
    expect((await upgrade(env)).status).toBe(403);
    db.exec("UPDATE memberships SET role = 'owner'");
    expect((await upgrade(env)).status).toBe(200);
  });

  it("uses the Fetch contract and returns one receipt for competing same-key commands", async () => {
    const { env } = fixture();
    const client = createRuntimeClient({
      baseUrl: "https://api",
      target: { workspaceId: "w", agentId: "a" },
      getAccessToken: async () => "test",
      fetch: (async (url, init) =>
        String(url).includes("package-snapshots")
          ? handleAgentPackageSnapshots(new Request(String(url), init), env, identity)
          : handleAgentPackageUpgrade(
              new Request(String(url), init),
              env,
              identity,
            )) as typeof fetch,
    });
    const [one, two] = await Promise.all([
      client.packages.upgrade(input),
      client.packages.upgrade(input),
    ]);
    expect(one).toEqual(two);
    expect(await client.packages.snapshots()).toMatchObject({
      currentRevision: 1,
      currentVersion: manifest.version,
    });
  });
});
