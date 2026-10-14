import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryCredentialVault } from "./credential-vault";
import { handleRefreshConnection } from "./connection-broker-oauth";
import { handleRevokeConnection } from "./connection-broker-connections";
import type { AgentIdentity, D1PreparedStatement, Env } from "./types";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const fixture = async (credential: Record<string, unknown>) => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec(`INSERT INTO users(id,status,created_at,updated_at) VALUES ('u','active','now','now');
    INSERT INTO workspaces(id,account_id,account_source,name,status,created_by_user_id,created_at,updated_at) VALUES ('w','acct','local','Workspace','active','u','now','now');
    INSERT INTO memberships(id,user_id,workspace_id,role,status,created_at,updated_at) VALUES ('m','u','w','owner','active','now','now');
    INSERT INTO agents(id,workspace_id,name,status,effect_target,created_by_user_id,created_at,updated_at) VALUES ('a','w','Desk','active','simulation','u','now','now');`);
  const vault = createMemoryCredentialVault();
  const stored = await vault.create({
    context: { workspaceId: "w" },
    name: "calendar",
    value: JSON.stringify(credential),
  });
  db.prepare(
    `INSERT INTO control_connections(id,user_id,workspace_id,agent_id,pack_id,connection_id,provider_id,principal,credential_class,status,scopes_json,vault_object_id,vault_version,created_at,updated_at)
     VALUES ('c','u','w','a','service-desk','calendar.primary','google-calendar','user','oauth2','authorized','["calendar.readonly"]',?,?,'now','now')`,
  ).run(stored.id, stored.version);
  type Statement = D1PreparedStatement & {
    execute(): { success: true; meta: { changes: number } };
  };
  const env = {
    OPERLOOM_E2E_MODE: "true",
    OPERLOOM_VAULT_BACKEND: "memory",
    OPERLOOM_CONNECTIONS_ENABLED: "true",
    OPERLOOM_OAUTH_PROVIDERS_JSON: JSON.stringify([
      {
        id: "google-calendar",
        authorizationUrl: "https://auth.example/o/oauth2/auth",
        tokenUrl: "https://auth.example/token",
        revocationUrl: "https://auth.example/revoke",
        actionUrl: "https://api.example/calendar/v3",
        clientId: "client-1",
        permittedHosts: ["auth.example", "api.example"],
      },
    ]),
    DB: {
      prepare(sql: string): Statement {
        let values: unknown[] = [];
        const statement: Statement = {
          bind(...args) {
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
        return statements.map((item) => item.execute());
      },
    },
  } as unknown as Env;
  const identity: AgentIdentity = { scope: { userId: "u", workspaceId: "w" }, agentId: "a" };
  const row = () =>
    db
      .prepare(
        "SELECT status, vault_version, token_expires_at, last_error_code, refresh_lease_owner FROM control_connections WHERE id='c'",
      )
      .get() as Record<string, unknown>;
  return { db, env, identity, vault, stored, row };
};

describe("OAuth connection refresh and revocation", () => {
  it("rotates the access token through the provider token endpoint under a lease", async () => {
    const f = await fixture({
      kind: "oauth2",
      accessToken: "old",
      refreshToken: "r1",
      scopes: ["calendar.readonly"],
    });
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: String(init?.body) });
        return Response.json({ access_token: "new", expires_in: 3600, token_type: "Bearer" });
      }),
    );
    const response = await handleRefreshConnection(f.env, f.identity, "calendar.primary");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: "authorized" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://auth.example/token");
    expect(calls[0]!.body).toContain("grant_type=refresh_token");
    expect(calls[0]!.body).toContain("refresh_token=r1");
    expect(calls[0]!.body).toContain("client_id=client-1");
    const after = f.row();
    expect(after.status).toBe("authorized");
    expect(after.refresh_lease_owner).toBeNull();
    expect(after.vault_version).not.toBe(f.stored.version);
    const rotated = JSON.parse(
      (await f.vault.read({ id: f.stored.id, version: String(after.vault_version) })).value,
    );
    // A provider that omits the refresh token keeps the previous one.
    expect(rotated).toMatchObject({
      accessToken: "new",
      refreshToken: "r1",
      scopes: ["calendar.readonly"],
    });
  });

  it("marks the connection refresh_required when the provider rejects the refresh", async () => {
    const f = await fixture({ kind: "oauth2", accessToken: "old", refreshToken: "r1", scopes: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 400 })),
    );
    const response = await handleRefreshConnection(f.env, f.identity, "calendar.primary");
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(f.row()).toMatchObject({
      status: "refresh_required",
      last_error_code: "connection_refresh_failed",
    });
    expect(f.db.prepare("SELECT code FROM control_operator_alerts").all()).toEqual([
      { code: "connection_refresh_failed" },
    ]);
  });

  it("revokes at the provider, destroys the vault object and records the audit event", async () => {
    const f = await fixture({ kind: "oauth2", accessToken: "old", refreshToken: "r1", scopes: [] });
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: String(init?.body) });
        return new Response(null, { status: 200 });
      }),
    );
    const response = await handleRevokeConnection(f.env, f.identity, "calendar.primary");
    expect(await response.json()).toMatchObject({
      ok: true,
      status: "revoked",
      providerRevoked: true,
    });
    expect(calls).toEqual([
      { url: "https://auth.example/revoke", body: "token=r1&client_id=client-1" },
    ]);
    expect(f.row()).toMatchObject({
      status: "revoked",
      vault_version: null,
      last_error_code: null,
    });
    await expect(f.vault.read({ id: f.stored.id, version: f.stored.version })).rejects.toThrow();
    expect(f.db.prepare("SELECT action FROM control_audit_events").all()).toEqual([
      { action: "connection.revoked" },
    ]);
  });
});
