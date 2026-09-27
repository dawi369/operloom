import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentIdentity, D1PreparedStatement, Env } from "./types";
import {
  deliverWebhooks,
  handleCreateWebhook,
  handleDisableWebhook,
  handleListWebhookDeliveries,
  handleRetryWebhookDelivery,
  signWebhookBody,
} from "./webhooks";

const owner: AgentIdentity = { scope: { userId: "u", workspaceId: "w" }, agentId: "a" };
const member: AgentIdentity = { scope: { userId: "v", workspaceId: "w" }, agentId: "a" };
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const fixture = () => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec(`INSERT INTO users (id,status,created_at,updated_at) VALUES ('u','active','now','now'), ('v','active','now','now');
    INSERT INTO workspaces (id,account_id,account_source,name,status,created_by_user_id,created_at,updated_at)
      VALUES ('w','acct','local','Workspace','active','u','now','now');
    INSERT INTO memberships (id,user_id,workspace_id,role,status,created_at,updated_at)
      VALUES ('m','u','w','owner','active','now','now'), ('n','v','w','member','active','now','now');`);
  type Statement = D1PreparedStatement & {
    execute(): { success: true; meta: { changes: number } };
  };
  const env = {
    OPERLOOM_AGENT_CONNECTION_SECRET: "webhook-test-master-secret",
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

const create = (env: Env, body: unknown, identity = owner) =>
  handleCreateWebhook(
    new Request("http://worker/webhooks", { method: "POST", body: JSON.stringify(body) }),
    env,
    identity,
  );
type Created = { endpoint: { id: string }; secret: string };
const addEvent = (db: DatabaseSync, id: string, type: string, createdAt: string) =>
  db
    .prepare(
      `INSERT INTO control_plane_events (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
       VALUES (?, 'u', 'w', 'a', ?, 'Something happened', 'run', 'run-1', '{"value":1}', ?)`,
    )
    .run(id, type, createdAt);
const deliveries = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT event_id, status, attempt_count, next_attempt_at, last_status_code, last_error_code FROM control_webhook_deliveries ORDER BY event_id",
    )
    .all() as {
    event_id: string;
    status: string;
    attempt_count: number;
    next_attempt_at: string;
    last_status_code: number | null;
    last_error_code: string | null;
  }[];

describe("webhook notifications", () => {
  it("registers admin-owned HTTPS endpoints and returns the signing secret once", async () => {
    const { env } = fixture();
    expect(
      (await create(env, { url: "https://hooks.example/a", eventTypes: ["*"] }, member)).status,
    ).toBe(403);
    for (const url of ["http://hooks.example/a", "https://user:pw@hooks.example/a", "not a url"])
      expect((await create(env, { url, eventTypes: ["*"] })).status).toBe(400);
    for (const eventTypes of [[], ["Bad Type"], ["run.**"]])
      expect((await create(env, { url: "https://hooks.example/a", eventTypes })).status).toBe(400);

    const created = await create(env, {
      url: "https://hooks.example/a",
      eventTypes: ["run.*", "agent.settings.changed"],
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as Created;
    expect(body.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    for (let index = 1; index < 10; index += 1)
      expect(
        (await create(env, { url: `https://hooks.example/${index}`, eventTypes: ["*"] })).status,
      ).toBe(201);
    const limited = await create(env, { url: "https://hooks.example/x", eventTypes: ["*"] });
    expect(limited.status).toBe(409);
  });

  it("delivers subscribed, settled events once with a verifiable signature", async () => {
    const { db, env } = fixture();
    const { endpoint, secret } = (await (
      await create(env, { url: "https://hooks.example/a", eventTypes: ["run.*"] })
    ).json()) as Created;
    const start = Date.now();
    const at = (offsetMs: number) => new Date(start + offsetMs);
    addEvent(db, "e1", "run.completed", at(1000).toISOString());
    addEvent(db, "e2", "agent.settings.changed", at(2000).toISOString());
    addEvent(db, "e3", "run.failed", at(50_000).toISOString());

    const fetcher = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    expect(await deliverWebhooks(env, at(60_000), fetcher as typeof fetch)).toMatchObject({
      queued: 1,
      delivered: 1,
    });
    const [url, init] = fetcher.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    expect(url).toBe("https://hooks.example/a");
    expect(init!.redirect).toBe("manual");
    expect(headers["x-operloom-event"]).toBe("run.completed");
    expect(headers["x-operloom-signature"]).toBe(
      await signWebhookBody(secret, Number(headers["x-operloom-timestamp"]), String(init!.body)),
    );
    expect(JSON.parse(String(init!.body))).toMatchObject({
      id: "e1",
      type: "run.completed",
      workspaceId: "w",
      target: { type: "run", id: "run-1" },
      data: { value: 1 },
    });

    // e3 settles on the next tick; e1 is never sent again.
    await deliverWebhooks(env, at(120_000), fetcher as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(deliveries(db).map((row) => [row.event_id, row.status])).toEqual([
      ["e1", "delivered"],
      ["e3", "delivered"],
    ]);
    const listed = (await (
      await handleListWebhookDeliveries(
        env,
        owner,
        endpoint.id,
        new URL("http://worker/webhooks/x/deliveries?status=delivered"),
      )
    ).json()) as { deliveries: { eventId: string }[] };
    expect(listed.deliveries.map((delivery) => delivery.eventId)).toEqual(["e3", "e1"]);
  });

  it("backs off, fails after the attempt budget, and retries on request", async () => {
    const { db, env } = fixture();
    const { endpoint } = (await (
      await create(env, { url: "https://hooks.example/a", eventTypes: ["*"] })
    ).json()) as Created;
    let clock = Date.now() + 60_000;
    addEvent(db, "e1", "run.failed", new Date(clock - 40_000).toISOString());
    const rejecting = vi.fn(async () => new Response("nope", { status: 503 }));
    await deliverWebhooks(env, new Date(clock), rejecting as unknown as typeof fetch);
    expect(deliveries(db)[0]).toMatchObject({
      status: "pending",
      attempt_count: 1,
      last_status_code: 503,
      last_error_code: "receiver_rejected",
      next_attempt_at: new Date(clock + 60_000).toISOString(),
    });
    await deliverWebhooks(env, new Date(clock + 30_000), rejecting as unknown as typeof fetch);
    expect(rejecting).toHaveBeenCalledTimes(1);

    for (let attempt = 2; attempt <= 8; attempt += 1) {
      clock = Date.parse(deliveries(db)[0]!.next_attempt_at);
      await deliverWebhooks(env, new Date(clock), rejecting as unknown as typeof fetch);
    }
    expect(deliveries(db)[0]).toMatchObject({ status: "failed", attempt_count: 8 });
    expect(rejecting).toHaveBeenCalledTimes(8);

    const deliveryId = (
      db.prepare("SELECT id FROM control_webhook_deliveries").get() as { id: string }
    ).id;
    expect((await handleRetryWebhookDelivery(env, member, endpoint.id, deliveryId)).status).toBe(
      403,
    );
    expect((await handleRetryWebhookDelivery(env, owner, endpoint.id, deliveryId)).status).toBe(
      200,
    );
    const accepting = vi.fn(async () => new Response(null, { status: 200 }));
    await deliverWebhooks(env, new Date(clock + 1000), accepting as unknown as typeof fetch);
    expect(deliveries(db)[0]).toMatchObject({ status: "delivered", attempt_count: 1 });
    expect((await handleRetryWebhookDelivery(env, owner, endpoint.id, deliveryId)).status).toBe(
      409,
    );
  });

  it("stops delivery when the endpoint is disabled or its owner loses admin", async () => {
    const { db, env } = fixture();
    const { endpoint } = (await (
      await create(env, { url: "https://hooks.example/a", eventTypes: ["*"] })
    ).json()) as Created;
    const clock = Date.now() + 60_000;
    addEvent(db, "e1", "run.failed", new Date(clock - 40_000).toISOString());
    const rejecting = vi.fn(async () => new Response(null, { status: 500 }));
    await deliverWebhooks(env, new Date(clock), rejecting as unknown as typeof fetch);
    expect((await handleDisableWebhook(env, owner, endpoint.id)).status).toBe(200);
    expect(deliveries(db)[0]).toMatchObject({
      status: "failed",
      last_error_code: "endpoint_disabled",
    });
    expect((await handleDisableWebhook(env, owner, "missing")).status).toBe(404);

    await create(env, { url: "https://hooks.example/b", eventTypes: ["*"] });
    db.exec("UPDATE memberships SET role = 'member' WHERE user_id = 'u'");
    addEvent(db, "e2", "run.failed", new Date(clock + 1000).toISOString());
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    await deliverWebhooks(env, new Date(clock + 120_000), fetcher as unknown as typeof fetch);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
