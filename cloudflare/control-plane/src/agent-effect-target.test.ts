import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1PreparedStatement, Env, WorkerExecutionContext } from "./types";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
vi.mock("agents", () => ({ routeAgentRequest: async () => null }));
vi.mock("@cloudflare/ai-chat", () => ({ AIChatAgent: class {} }));

const { default: worker } = await import("./index");

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const fixture = () => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  type Statement = D1PreparedStatement & {
    execute(): { success: true; meta: { changes: number } };
  };
  const env = {
    OPERLOOM_LOCAL_API_ENABLED: "true",
    OPERLOOM_ENVIRONMENT: "local",
    OPERLOOM_LOCAL_API_TOKEN: "local-test-token",
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
  return { db, env };
};

const ctx: WorkerExecutionContext = { waitUntil() {} };
const call = (env: Env, path: string, init?: RequestInit & { user?: string }) =>
  worker.fetch!(
    new Request(`http://127.0.0.1:8787${path}`, {
      ...init,
      headers: {
        authorization: "Bearer local-test-token",
        "content-type": "application/json",
        ...(init?.user ? { "x-operloom-local-user": init.user } : {}),
        ...init?.headers,
      },
    }) as never,
    env,
    ctx as never,
  );
const agentPath =
  "/v1/me/agents/agent-workspace%3Alocal-api%3Aoperloom-local%3Adefault/effect-target";
type TargetBody = {
  ok: boolean;
  code?: string;
  effectTarget: "simulation" | "external";
  runtimeRevision: number;
};

describe("agent effect target", () => {
  it("starts in simulation and switches through a revision-fenced, audited change", async () => {
    const { db, env } = fixture();
    const first = await call(env, agentPath);
    const initial = (await first.json()) as TargetBody;
    expect(initial).toMatchObject({ ok: true, effectTarget: "simulation" });

    const changed = await call(env, agentPath, {
      method: "PUT",
      body: JSON.stringify({ effectTarget: "external", expectedRevision: initial.runtimeRevision }),
    });
    expect(changed.status).toBe(200);
    const body = (await changed.json()) as TargetBody;
    expect(body).toMatchObject({
      effectTarget: "external",
      runtimeRevision: initial.runtimeRevision + 1,
    });
    const event = db
      .prepare(
        "SELECT data_json FROM control_plane_events WHERE type = 'agent.effect_target.changed'",
      )
      .get() as { data_json: string };
    expect(JSON.parse(event.data_json)).toMatchObject({ from: "simulation", to: "external" });

    const stale = await call(env, agentPath, {
      method: "PUT",
      body: JSON.stringify({
        effectTarget: "simulation",
        expectedRevision: initial.runtimeRevision,
      }),
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as TargetBody).code).toBe("agent_revision_conflict");

    const unchanged = (await (
      await call(env, agentPath, {
        method: "PUT",
        body: JSON.stringify({ effectTarget: "external", expectedRevision: body.runtimeRevision }),
      })
    ).json()) as TargetBody;
    expect(unchanged.runtimeRevision).toBe(body.runtimeRevision);
  });

  it("refuses a target change without a database revision bump", () => {
    const { db } = fixture();
    db.exec(`INSERT INTO agents (id,workspace_id,name,status,created_by_user_id,created_at,updated_at)
      VALUES ('a','w','Agent','active','u','now','now')`);
    expect(() => db.exec("UPDATE agents SET effect_target = 'external' WHERE id = 'a'")).toThrow(
      "agent_effect_target_revision_required",
    );
  });

  it("rejects runs pinned to a different target than the agent", () => {
    const { db } = fixture();
    db.exec(`INSERT INTO agents (id,workspace_id,name,status,created_by_user_id,created_at,updated_at)
      VALUES ('a','w','Agent','active','u','now','now')`);
    const insertRun = (target: string) =>
      db
        .prepare(`INSERT INTO control_runs (id,user_id,workspace_id,agent_id,workflow_intent_id,status,execution_json,data_json,created_at,updated_at)
          VALUES (?, 'u','w','a','intent','running','{}',?, 'now','now')`)
        .run(`run-${target}`, JSON.stringify({ agentRevision: 0, effectTarget: target }));
    expect(() => insertRun("external")).toThrow();
    expect(() => insertRun("simulation")).not.toThrow();
  });

  it("allows only owners and admins to change the target", async () => {
    const { db, env } = fixture();
    const owner = (await (await call(env, agentPath)).json()) as TargetBody;
    const account = (await (await call(env, "/v1/account", { user: "member" })).json()) as {
      context: { identity: { userId: string } };
    };
    db.prepare(
      `INSERT INTO memberships (id,user_id,workspace_id,role,status,created_at,updated_at)
       VALUES ('member-m', ?, 'workspace:local-api:operloom-local:default', 'member', 'active', 'now', 'now')`,
    ).run(account.context.identity.userId);
    const scoped =
      "/v1/workspaces/workspace%3Alocal-api%3Aoperloom-local%3Adefault/agents/agent-workspace%3Alocal-api%3Aoperloom-local%3Adefault/agents/agent-workspace%3Alocal-api%3Aoperloom-local%3Adefault/effect-target";
    const denied = await call(env, scoped, {
      method: "PUT",
      user: "member",
      body: JSON.stringify({ effectTarget: "external", expectedRevision: owner.runtimeRevision }),
    });
    expect(denied.status).toBe(403);
  });
});
