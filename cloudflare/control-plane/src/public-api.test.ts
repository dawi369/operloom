import { describe, expect, it, vi } from "vitest";
import { handlePublicApi } from "./public-api";
import { authenticatePublicApi } from "./public-api-auth";
import type { Env } from "./types";

const env = {
  WORKBENCH_LOCAL_API_ENABLED: "true",
  WORKBENCH_ENVIRONMENT: "local",
  CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN: "local-test-token",
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
      expect(command.headers.get("x-assistant-mk1-user-id")).toBe("operloom-local");
      expect(command.headers.get("x-assistant-mk1-workspace-id")).toBe("my-workspace");
      expect(command.headers.get("x-assistant-mk1-agent-id")).toBe("my-agent");
      expect(command.headers.has("cookie")).toBe(false);
      expect(command.headers.has("x-assistant-mk1-membership-status")).toBe(false);
      return Response.json({ ok: true });
    });
    const response = await handlePublicApi(
      request("/v1/workspaces/my-workspace/agents/my-agent/workbench/history/runs", {
        headers: {
          "x-assistant-mk1-user-id": "victim",
          "x-assistant-mk1-membership-status": "active",
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
        WORKBENCH_ENVIRONMENT: "production",
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
});
