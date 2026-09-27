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
  const queries: string[] = [];
  type Statement = D1PreparedStatement & {
    execute(): { success: true; meta: { changes: number } };
  };
  const env = {
    WORKBENCH_LOCAL_API_ENABLED: "true",
    WORKBENCH_ENVIRONMENT: "local",
    CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN: "local-test-token",
    DB: {
      prepare(query: string): Statement {
        queries.push(query);
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
        return statements.map((statement) => statement.execute());
      },
    },
  } as unknown as Env;
  return { db, env, queries };
};

const ctx: WorkerExecutionContext = { waitUntil() {} };
const forgedIdentity = {
  "x-api-key": "local-test-token",
  "x-assistant-mk1-user-id": "victim",
  "x-assistant-mk1-account-id": "victim-account",
  "x-assistant-mk1-account-source": "workos_organization",
  "x-assistant-mk1-workspace-id": "workspace:victim-account:default",
  "x-assistant-mk1-agent-id": "agent-workspace:victim-account:default",
  "x-assistant-mk1-membership-role": "owner",
  "x-assistant-mk1-platform-operator": "true",
};
const call = (env: Env, path: string, init?: RequestInit) =>
  worker.fetch!(
    new Request(`http://127.0.0.1:8787${path}`, {
      ...init,
      headers: { authorization: "Bearer local-test-token", ...init?.headers },
    }) as never,
    env,
    ctx as never,
  );

type AccountBody = {
  context: { identity: { userId: string; workspaceId: string; agentId: string } };
};

describe("public control-plane boundary", () => {
  it("does not serve internal routes from the network, even with the local token", async () => {
    const { env, queries } = fixture();
    for (const [method, path] of [
      ["GET", "/workspace-context"],
      ["GET", "/health/facade"],
      ["POST", "/tools/runs"],
      ["GET", "/events/stream"],
      ["POST", "/admin/workspace-purges/workspace-1/retry"],
      ["POST", "/workbench/workflows/repo.readiness_report"],
    ] as const) {
      const response = await call(env, path, { method, headers: forgedIdentity });
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual({ ok: false, code: "not_found", error: "Not found" });
    }
    expect(queries).toEqual([]);
  });

  it("derives identity from the token and ignores forged identity headers on /v1", async () => {
    const { db, env } = fixture();
    const response = await call(env, "/v1/account", { headers: forgedIdentity });
    expect(response.status).toBe(200);
    const body = (await response.json()) as AccountBody;
    expect(body.context.identity).toMatchObject({
      userId: "operloom-local",
      workspaceId: "workspace:local-api:operloom-local:default",
      agentId: "agent-workspace:local-api:operloom-local:default",
    });
    expect(db.prepare("SELECT id FROM users").all()).toEqual([{ id: "operloom-local" }]);
  });

  it("keeps local test users isolated from each other's explicit targets", async () => {
    const { env } = fixture();
    const alice = (await (
      await call(env, "/v1/account", { headers: { "x-operloom-local-user": "alice" } })
    ).json()) as AccountBody;
    expect(alice.context.identity.userId).toBe("alice");
    const { workspaceId, agentId } = alice.context.identity;
    const bob = { "x-operloom-local-user": "bob" };
    expect((await call(env, "/v1/account", { headers: bob })).status).toBe(200);
    const scoped = `/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/workspaces`;
    expect(
      (await call(env, scoped, { headers: { "x-operloom-local-user": "alice" } })).status,
    ).toBe(200);
    expect((await call(env, scoped, { headers: { ...bob, ...forgedIdentity } })).status).toBe(403);
  });
});
