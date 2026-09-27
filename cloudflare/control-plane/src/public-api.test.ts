import { describe, expect, it, vi } from "vitest";
import { handlePublicApi } from "./public-api";
import { authenticatePublicApi, publicApiCommandRequest } from "./public-api-auth";
import type { Env } from "./types";

vi.mock("../../../lib/workbench/access-token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/workbench/access-token")>()),
  verifyWorkbenchAccessToken: vi.fn(async () => ({
    scope: { userId: "workos-user", workspaceId: "workspace:org-1:default" },
    accountId: "org-1",
    accountSource: "workos_organization",
    workspaceSource: "workos",
    authMode: "workos",
  })),
}));

const env = {
  OPERLOOM_LOCAL_API_ENABLED: "true",
  OPERLOOM_ENVIRONMENT: "local",
  OPERLOOM_LOCAL_API_TOKEN: "local-test-token",
} as Env;
const request = (path: string, init?: RequestInit) =>
  new Request(`http://127.0.0.1:8787${path}`, {
    ...init,
    headers: { authorization: "Bearer local-test-token", ...init?.headers },
  });

describe("public API boundary", () => {
  it("validates bounded action queries before dispatch", async () => {
    const dispatch = vi.fn(async () => Response.json({ ok: true, proposals: [] }));
    for (const query of ["limit=0", "limit=101", "limit=1.5", "limit=bad", "workspaceId=other"]) {
      expect(
        (
          await handlePublicApi(
            request(`/v1/workspaces/w/agents/a/workbench/actions?${query}`),
            env,
            dispatch,
          )
        ).status,
      ).toBe(400);
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      (
        await handlePublicApi(
          request("/v1/workspaces/w/agents/a/workbench/actions?limit=20"),
          env,
          dispatch,
        )
      ).status,
    ).toBe(200);
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it("reports obsolete execution authority as an actionable conflict without database details", async () => {
    const response = await handlePublicApi(
      request("/v1/workspaces/w/agents/a/tools/runs", { method: "POST" }),
      env,
      async () => {
        throw new Error("D1_ERROR: agent_runtime_revision_conflict: INSERT private SQL");
      },
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: false,
      code: "agent_runtime_revision_conflict",
      requestId: expect.any(String),
    });
    expect(body.error).toContain("Refresh");
    expect(JSON.stringify(body)).not.toContain("private SQL");
  });
  it("never lets a response be cached and keeps a handler's private directive", async () => {
    const call = (cacheControl?: string) =>
      handlePublicApi(request("/v1/me/workbench/data-exports/job/download"), env, async () =>
        cacheControl
          ? new Response("zip", { headers: { "cache-control": cacheControl } })
          : new Response("zip"),
      );
    expect((await call()).headers.get("cache-control")).toBe("no-store");
    expect((await call("max-age=60")).headers.get("cache-control")).toBe("no-store");
    expect((await call("private, no-store")).headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });
  it("reports an export fence as a retryable 423 without database details", async () => {
    const response = await handlePublicApi(
      request("/v1/me/workbench/retention-policy", { method: "PATCH" }),
      env,
      async () => {
        throw new Error("D1_ERROR: workspace_export_in_progress: UPDATE private SQL");
      },
    );
    expect(response.status).toBe(423);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, code: "workspace_export_in_progress" });
    expect(JSON.stringify(body)).not.toContain("private SQL");
  });
  it("retains canonical error codes and retry metadata for independent clients", async () => {
    const response = await handlePublicApi(
      request("/v1/workspaces/w/agents/a/tools/runs", { method: "POST" }),
      env,
      async () =>
        Response.json(
          { ok: false, error: "Budget exhausted", details: { code: "budget_exhausted" } },
          { status: 429, headers: { "retry-after": "60" } },
        ),
    );
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toMatchObject({
      code: "budget_exhausted",
      requestId: expect.any(String),
    });
  });
  it("uses explicit scope and drops forged identity, signatures and cookies", async () => {
    const dispatch = vi.fn(async (command: Request) => {
      expect(new URL(command.url).pathname).toBe("/workbench/history/runs");
      expect(command.headers.get("x-operloom-user-id")).toBe("operloom-local");
      expect(command.headers.get("x-operloom-workspace-id")).toBe("my-workspace");
      expect(command.headers.get("x-operloom-agent-id")).toBe("my-agent");
      expect(command.headers.has("cookie")).toBe(false);
      expect(command.headers.has("x-operloom-membership-status")).toBe(false);
      return Response.json({ ok: true });
    });
    const response = await handlePublicApi(
      request("/v1/workspaces/my-workspace/agents/my-agent/workbench/history/runs", {
        headers: {
          "x-operloom-user-id": "victim",
          "x-operloom-membership-status": "active",
          cookie: "forged=1",
        },
      }),
      env,
      dispatch,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it("rejects internal routes and unscoped commands", async () => {
    for (const path of [
      "/v1/workbench/workflows/test",
      "/v1/workspaces/w/agents/a/workbench/run-callbacks",
      "/v1/workspaces/w/agents/a/workbench/connection-capabilities/redeem",
    ]) {
      const dispatch = vi.fn();
      expect((await handlePublicApi(request(path, { method: "POST" }), env, dispatch)).status).toBe(
        404,
      );
      expect(dispatch).not.toHaveBeenCalled();
    }
  });
  it("never accepts a local credential on a hosted origin or configuration", async () => {
    await expect(
      authenticatePublicApi(
        new Request("https://runtime.example/v1/account", {
          headers: { authorization: "Bearer local-test-token" },
        }),
        env,
      ),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      authenticatePublicApi(request("/v1/account"), {
        ...env,
        OPERLOOM_ENVIRONMENT: "production",
      }),
    ).rejects.toMatchObject({ status: 503 });
  });
  it("does not dispatch invalid tokens", async () => {
    const dispatch = vi.fn();
    expect(
      (
        await handlePublicApi(
          request("/v1/account", { headers: { authorization: "Bearer invalid" } }),
          env,
          dispatch,
        )
      ).status,
    ).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("supports authenticated browser commands with preflight and request IDs", async () => {
    const result = await handlePublicApi(
      request("/v1/account", { method: "OPTIONS", headers: { origin: "http://localhost:3000" } }),
      env,
      vi.fn(),
    );
    expect(result.status).toBe(204);
    expect(result.headers.get("access-control-allow-headers")).toContain("idempotency-key");
  });
  it("selects a validated local user only in loopback local mode with the local token", async () => {
    const withUser = (user: string, init?: { url?: string; token?: string }) =>
      new Request(init?.url ?? "http://127.0.0.1:8787/v1/account", {
        headers: {
          authorization: `Bearer ${init?.token ?? "local-test-token"}`,
          "x-operloom-local-user": user,
        },
      });
    const { principal } = await authenticatePublicApi(withUser("alice.test:1"), env);
    expect(principal.scope.userId).toBe("alice.test:1");
    expect(principal.accountId).toBe("local-api:alice.test:1");
    expect((await authenticatePublicApi(request("/v1/account"), env)).principal.scope.userId).toBe(
      "operloom-local",
    );
    for (const user of ["", "bob/../admin", "a".repeat(129), "bob smith"]) {
      await expect(authenticatePublicApi(withUser(user), env)).rejects.toMatchObject({
        status: 400,
      });
    }
    await expect(
      authenticatePublicApi(withUser("alice", { token: "wrong" }), env),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      authenticatePublicApi(withUser("alice", { url: "https://runtime.example/v1/account" }), env),
    ).rejects.toMatchObject({ status: 503 });
    const hosted = await authenticatePublicApi(withUser("alice", { token: "workos-jwt" }), {
      OPERLOOM_WORKOS_ISSUER: "https://auth.example",
      OPERLOOM_WORKOS_JWKS_URL: "https://auth.example/jwks",
      OPERLOOM_WORKOS_ALLOWED_CLIENT_IDS: "client_1",
    } as Env);
    expect(hosted.context.mode).toBe("access_token");
    expect(hosted.principal.scope.userId).toBe("workos-user");
  });
  it("seeds the user profile only from verified token claims", () => {
    const principal = {
      scope: { userId: "user_1", workspaceId: "workspace:workos-personal:user_1:default" },
      accountId: "workos-personal:user_1",
      accountSource: "workos-personal",
      workspaceSource: "workos-personal",
      authMode: "workos",
    } as const;
    const forged = new Request("http://127.0.0.1:8787/v1/account", {
      headers: {
        "x-operloom-user-email": "forged@example.com",
        "x-operloom-user-name": "Forged",
      },
    });
    const claimed = publicApiCommandRequest(forged, {
      principal: { ...principal, userEmail: "ada@example.com", userName: "Ada" },
      path: "/workspace-context",
    });
    expect(claimed.headers.get("x-operloom-user-email")).toBe("ada@example.com");
    expect(claimed.headers.get("x-operloom-user-name")).toBe("Ada");
    const unclaimed = publicApiCommandRequest(forged, { principal, path: "/workspace-context" });
    expect(unclaimed.headers.has("x-operloom-user-email")).toBe(false);
    expect(unclaimed.headers.has("x-operloom-user-name")).toBe(false);
  });
});
