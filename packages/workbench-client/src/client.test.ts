import { describe, expect, it, vi } from "vitest";

import { createWorkbenchClient } from "./client.js";

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

describe("createWorkbenchClient", () => {
  it("uses bearer authority and redaction-safe client metadata", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ ok: true, workspaces: [] }, { headers: { "x-request-id": "req_1" } }),
    );
    const client = createWorkbenchClient({
      baseUrl: "https://workbench.example/",
      client: { platform: "ios", version: "1.2.3" },
      fetch: fetcher,
      getAccessToken: async () => "mobile-token",
    });

    await client.workspaces.list();

    const [url, init] = fetcher.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(url).toBe("https://workbench.example/api/workbench/workspaces");
    expect(headers.get("authorization")).toBe("Bearer mobile-token");
    expect(headers.get("x-workbench-client-platform")).toBe("ios");
    expect(headers.get("x-workbench-client-version")).toBe("1.2.3");
    expect(init?.credentials).toBe("omit");
  });

  it("preserves cookie sessions when no bearer token is supplied", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true, agents: [] }));
    const client = createWorkbenchClient({
      baseUrl: "",
      client: { platform: "web", version: "0.1.0" },
      fetch: fetcher,
    });

    await client.agents.list();

    expect(fetcher.mock.calls[0]![1]?.credentials).toBe("include");
  });

  it("uses stable turn identity for materialization", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = createWorkbenchClient({
      baseUrl: "https://workbench.example",
      client: { platform: "android", version: "0.1.0" },
      fetch: fetcher,
    });

    await client.session.materializeTurn({ clientTurnId: "turn_1", text: "hello" });

    const headers = new Headers(fetcher.mock.calls[0]![1]?.headers);
    expect(headers.get("idempotency-key")).toBe("turn_1");
    expect(fetcher.mock.calls[0]![1]?.body).toBe(
      JSON.stringify({ message: "hello", clientTurnId: "turn_1" }),
    );
  });

  it("discovers workflows through the portable contract", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        ok: true,
        runnable: true,
        workflows: [
          {
            type: "operator.inspect",
            label: "Inspect",
            engine: "cloudflare",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
            toolIds: [],
          },
        ],
      }),
    );
    const client = createWorkbenchClient({
      baseUrl: "https://workbench.example",
      client: { platform: "android", version: "0.1.0" },
      fetch: fetcher,
    });

    const response = await client.workflows.list();

    expect(response.workflows).toHaveLength(1);
    expect(fetcher.mock.calls[0]![0]).toBe("https://workbench.example/api/workbench/workflows");
  });

  it("registers and revokes mobile delivery without changing token ownership", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ ok: true, enabled: true, devices: [] }),
    );
    const client = createWorkbenchClient({
      baseUrl: "https://workbench.example",
      client: { platform: "ios", version: "0.1.0" },
      fetch: fetcher,
      getAccessToken: async () => "access-token",
    });

    await client.devices.register({
      installationId: "installation-0001",
      platform: "ios",
      token: "ExponentPushToken[opaque]",
      appVersion: "0.1.0",
    });
    await client.devices.revoke("device-1");

    expect(fetcher.mock.calls[0]![0]).toBe("https://workbench.example/api/workbench/devices");
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("idempotency-key")).toBe(
      "installation-0001",
    );
    expect(fetcher.mock.calls[1]![0]).toBe(
      "https://workbench.example/api/workbench/devices/device-1",
    );
    expect(fetcher.mock.calls[1]![1]?.method).toBe("DELETE");
  });

  it("rejects malformed successful responses", async () => {
    const client = createWorkbenchClient({
      baseUrl: "https://workbench.example",
      client: { platform: "web", version: "0.1.0" },
      fetch: async () =>
        jsonResponse(
          { ok: true, runs: {}, accessToken: "credential-must-not-appear" },
          { headers: { "x-request-id": "req_invalid" } },
        ),
    });

    const error = await client.history.listRuns().catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "invalid_response",
      requestId: "req_invalid",
      status: 0,
      retryable: false,
    });
    expect(String(error)).not.toContain("credential-must-not-appear");
  });

  it("fails closed on an unsupported chat protocol", async () => {
    const client = createWorkbenchClient({
      baseUrl: "https://workbench.example",
      client: { platform: "ios", version: "0.1.0" },
      fetch: async () => jsonResponse({ ok: true, connection: { chatProtocolVersion: 3 } }),
    });

    await expect(client.session.get()).rejects.toMatchObject({
      code: "invalid_response",
      status: 0,
    });
  });

  it("normalizes API failures without exposing response bodies", async () => {
    const client = createWorkbenchClient({
      baseUrl: "https://workbench.example",
      client: { platform: "web", version: "0.1.0" },
      fetch: async () =>
        jsonResponse(
          { error: "Not found", code: "not_found", retryable: false, secret: "hidden" },
          { status: 404, headers: { "x-request-id": "req_404" } },
        ),
    });

    await expect(client.history.getRun("run_404")).rejects.toMatchObject({
      message: "Not found",
      code: "not_found",
      requestId: "req_404",
      retryable: false,
      status: 404,
    });
  });

  it("propagates read cancellation without classifying it as retryable", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(init.signal.reason);
            return;
          }
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const client = createWorkbenchClient({
      baseUrl: "https://workbench.example",
      client: { platform: "web", version: "0.1.1" },
      fetch: fetcher,
    });
    const controller = new AbortController();
    const request = client.connections.list({ signal: controller.signal });

    controller.abort();

    await expect(request).rejects.toMatchObject({
      code: "request_cancelled",
      retryable: false,
      status: 0,
    });
  });
});

it("keeps cold workflow execution alive beyond the ordinary browser timeout", async () => {
  vi.useFakeTimers();
  const client = createWorkbenchClient({
    baseUrl: "https://workbench.example",
    client: { platform: "web", version: "0.1.0" },
    fetch: vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(jsonResponse({ ok: true })), 25_000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    ),
  });
  try {
    const result = client.workflows.run("repo.readiness_report");
    await vi.advanceTimersByTimeAsync(25_000);
    expect((await result).ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
