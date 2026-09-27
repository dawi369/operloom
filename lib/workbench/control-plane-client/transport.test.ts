import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  controlPlaneRequest,
  fetchWithTimeout,
  requestControlPlane,
  targetCookieName,
} from "./transport";

const jar = vi.hoisted(() => new Map<string, { value: string; options?: unknown }>());
const session = vi.hoisted(() => ({
  current: { authMode: "local-dev", accessToken: "local-token" } as Record<string, unknown>,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: unknown) => jar.set(name, { value, options }),
    delete: (input: string | { name: string }) =>
      jar.delete(typeof input === "string" ? input : input.name),
  }),
}));
vi.mock("@/lib/workbench/agent-identity", () => ({
  getWorkbenchSession: async () => session.current,
}));

const base = "http://127.0.0.1:8787";
const scope = `${base}/v1/workspaces/${encodeURIComponent("workspace:local-api:operloom-local:default")}/agents/${encodeURIComponent("agent-workspace:local-api:operloom-local:default")}`;
const account = (workspaceId: string, agentId: string) =>
  Response.json({
    ok: true,
    context: { identity: { userId: "operloom-local", workspaceId, agentId } },
  });
const defaultAccount = () =>
  account(
    "workspace:local-api:operloom-local:default",
    "agent-workspace:local-api:operloom-local:default",
  );
const storeTarget = (workspaceId: string, agentId: string, principal = "local-dev") =>
  jar.set(targetCookieName, { value: JSON.stringify({ principal, workspaceId, agentId }) });

describe("control-plane /v1 transport", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const calls = () =>
    fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: (init as RequestInit).method,
      headers: new Headers((init as RequestInit).headers),
    }));

  beforeEach(() => {
    jar.clear();
    session.current = { authMode: "local-dev", accessToken: "local-token" };
    vi.stubEnv("CLOUDFLARE_CONTROL_PLANE_URL", `${base}/`);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("maps workspace context to the account route with only the user's bearer", async () => {
    fetchMock.mockResolvedValueOnce(defaultAccount());
    await controlPlaneRequest("/workspace-context?refresh=1", {
      headers: {
        "x-assistant-mk1-user-id": "victim",
        "x-assistant-mk1-workspace-id": "other",
        cookie: "wos-session=forged",
        accept: "application/json",
      },
    });
    const [call] = calls();
    expect(call!.url).toBe(`${base}/v1/account?refresh=1`);
    expect(call!.headers.get("authorization")).toBe("Bearer local-token");
    expect(call!.headers.get("accept")).toBe("application/json");
    expect([...call!.headers.keys()].sort()).toEqual(["accept", "authorization", "content-type"]);
    expect(jar.has(targetCookieName)).toBe(false);
  });

  it("resolves the target through the account once and persists it in an httpOnly cookie", async () => {
    fetchMock
      .mockResolvedValueOnce(defaultAccount())
      .mockResolvedValueOnce(Response.json({ ok: true, tools: [] }))
      .mockResolvedValueOnce(Response.json({ ok: true, tools: [] }));
    await requestControlPlane("/tools?stage=observe");
    await requestControlPlane("/tools");
    expect(calls().map(({ url }) => url)).toEqual([
      `${base}/v1/account`,
      `${scope}/tools?stage=observe`,
      `${scope}/tools`,
    ]);
    for (const call of calls()) {
      expect([...call.headers.keys()].some((name) => name.startsWith("x-assistant-mk1-"))).toBe(
        false,
      );
    }
    expect(JSON.parse(jar.get(targetCookieName)!.value)).toEqual({
      principal: "local-dev",
      workspaceId: "workspace:local-api:operloom-local:default",
      agentId: "agent-workspace:local-api:operloom-local:default",
    });
    expect(jar.get(targetCookieName)!.options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
  });

  it("uses the signed-in WorkOS access token and ignores another principal's cookie", async () => {
    session.current = {
      authMode: "workos",
      accessToken: "workos-access-token",
      userId: "user_1",
      userEmail: "user@example.com",
    };
    storeTarget("workspace:other", "agent-other");
    fetchMock
      .mockResolvedValueOnce(account("workspace:workos-personal:user_1:default", "agent-1"))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await requestControlPlane("/agents");
    expect(calls().map(({ url }) => url)).toEqual([
      `${base}/v1/account`,
      `${base}/v1/workspaces/${encodeURIComponent("workspace:workos-personal:user_1:default")}/agents/agent-1/agents`,
    ]);
    expect(calls()[1]!.headers.get("authorization")).toBe("Bearer workos-access-token");
  });

  it("clears the cached target after a call that changes the active agent", async () => {
    storeTarget("workspace:local-api:operloom-local:default", "agent-old");
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    await requestControlPlane("/agents/agent-new/activate", { method: "POST" });
    expect(calls()[0]!.url).toContain("/agents/agent-old/agents/agent-new/activate");
    expect(jar.has(targetCookieName)).toBe(false);
  });

  it("re-resolves a stale target once for reads and keeps failed writes unretried", async () => {
    storeTarget("workspace:deleted", "agent-deleted");
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ ok: false, error: "Workspace is not active" }, { status: 403 }),
      )
      .mockResolvedValueOnce(defaultAccount())
      .mockResolvedValueOnce(Response.json({ ok: true, threads: [] }));
    await requestControlPlane("/chat/session/threads");
    expect(calls().map(({ url }) => url)).toEqual([
      `${base}/v1/workspaces/${encodeURIComponent("workspace:deleted")}/agents/agent-deleted/chat/session/threads`,
      `${base}/v1/account`,
      `${scope}/chat/session/threads`,
    ]);

    fetchMock.mockClear();
    storeTarget("workspace:deleted", "agent-deleted");
    fetchMock.mockResolvedValueOnce(
      Response.json({ ok: false, error: "Agent is not active" }, { status: 403 }),
    );
    await expect(
      requestControlPlane("/tools/runs", { method: "POST", body: "{}" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(jar.has(targetCookieName)).toBe(false);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("allows a cold workflow response beyond the normal request deadline", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url, init) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response("ok")), 20_000);
          init.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    ),
  );
  const workflow = fetchWithTimeout("https://example.test", {}, 45_000);
  const ordinary = expect(fetchWithTimeout("https://example.test", {})).rejects.toThrow("10000ms");
  await vi.advanceTimersByTimeAsync(20_000);
  await ordinary;
  expect((await workflow).status).toBe(200);
  expect(vi.getTimerCount()).toBe(0);
});
