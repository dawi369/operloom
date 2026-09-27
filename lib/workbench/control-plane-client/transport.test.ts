import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { controlPlaneRequest, fetchWithTimeout, requestControlPlane } from "./transport";

const session = vi.hoisted(() => ({
  current: { authMode: "local-dev", accessToken: "local-token" } as Record<string, unknown>,
}));

vi.mock("@/lib/workbench/agent-identity", () => ({
  getWorkbenchSession: async () => session.current,
}));

const base = "http://127.0.0.1:8787";

describe("control-plane /v1 transport", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const calls = () =>
    fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: (init as RequestInit).method,
      headers: new Headers((init as RequestInit).headers),
    }));

  beforeEach(() => {
    session.current = { authMode: "local-dev", accessToken: "local-token" };
    vi.stubEnv("OPERLOOM_BACKEND_URL", `${base}/`);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("maps workspace context to the account route with only the user's bearer", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    await controlPlaneRequest("/workspace-context?refresh=1", {
      headers: {
        "x-operloom-user-id": "victim",
        "x-operloom-workspace-id": "other",
        cookie: "wos-session=forged",
        accept: "application/json",
      },
    });
    const [call] = calls();
    expect(call!.url).toBe(`${base}/v1/account?refresh=1`);
    expect(call!.headers.get("authorization")).toBe("Bearer local-token");
    expect([...call!.headers.keys()].sort()).toEqual(["accept", "authorization", "content-type"]);
  });

  it("routes every operation through /v1/me so the Worker resolves the active target", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ ok: true, tools: [] }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await requestControlPlane("/tools?stage=observe");
    await requestControlPlane("/chat/session/agent-switch", {
      method: "POST",
      body: "{}",
      headers: { "idempotency-key": "switch-1", "x-operloom-agent-id": "forged" },
    });
    expect(calls().map(({ url, method }) => [method, url])).toEqual([
      ["GET", `${base}/v1/me/tools?stage=observe`],
      ["POST", `${base}/v1/me/chat/session/agent-switch`],
    ]);
    expect(calls()[1]!.headers.get("idempotency-key")).toBe("switch-1");
    for (const call of calls()) {
      expect([...call.headers.keys()].some((name) => name.startsWith("x-operloom-"))).toBe(false);
    }
  });

  it("uses the signed-in WorkOS access token", async () => {
    session.current = {
      authMode: "workos",
      accessToken: "workos-access-token",
      userId: "user_1",
      userEmail: "user@example.com",
    };
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    await requestControlPlane("/agents");
    expect(calls()[0]!.url).toBe(`${base}/v1/me/agents`);
    expect(calls()[0]!.headers.get("authorization")).toBe("Bearer workos-access-token");
  });

  it("surfaces Worker failures without retrying writes", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ ok: false, error: "Agent is not active" }, { status: 403 }),
    );
    await expect(
      requestControlPlane("/tools/runs", { method: "POST", body: "{}" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledOnce();
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
