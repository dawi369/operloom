import { describe, expect, it, vi } from "vitest";
import { createRuntimeClient } from "./runtime-client";
import { createFetchChatTransport } from "./fetch-chat-transport";
import { toPublicMessage } from "./messages";
import { publicApiOpenApi } from "./public-api";

const options = {
  baseUrl: "https://runtime.example",
  target: { workspaceId: "w", agentId: "a" },
  getAccessToken: async () => "token",
};
describe("runtime Fetch client", () => {
  it("scopes provider receipt inspection and recovery commands to the explicit client target", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, proposals: [] }))
      .mockResolvedValueOnce(
        Response.json(
          {
            ok: false,
            code: "approval_required",
            proposalId: "proposal/a",
            approvalRequest: {
              id: "approval",
              status: "requested",
              requestHash: "hash",
              expiresAt: "2026-09-27T10:00:00.000Z",
            },
            run: { id: "run", workflowIntentId: "intent", status: "interrupted" },
          },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          result: { proposalId: "proposal/a", status: "reconciled", summary: "Done" },
        }),
      );
    const client = createRuntimeClient({ ...options, fetch: fetcher });
    await client.admin.actions();
    await client.admin.requestAction("proposal/a");
    await client.admin.reconcileAction("proposal/a");
    expect(fetcher.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://runtime.example/v1/workspaces/w/agents/a/workbench/actions",
      "https://runtime.example/v1/workspaces/w/agents/a/workbench/actions/proposal%2Fa/execute",
      "https://runtime.example/v1/workspaces/w/agents/a/workbench/actions/proposal%2Fa/reconcile",
    ]);
    expect(fetcher.mock.calls.map((call) => call[1]?.method)).toEqual(["GET", "POST", "POST"]);
  });

  it("validates provider receipts and documents asynchronous action acceptance", async () => {
    const valid = {
      id: "action",
      toolId: "capacity.allocate",
      actionType: "allocate",
      status: "executing",
      summary: "Allocate",
      version: 1,
      createdAt: "2026-09-27T10:00:00.000Z",
      updatedAt: "2026-09-27T10:00:00.000Z",
      terminalAt: null,
      externalReference: null,
      ledger: [],
      providerOperation: {
        id: "receipt",
        operationId: "capacity.allocate",
        version: "1",
        status: "succeeded",
        output: { lifecycle: "pending" },
        updatedAt: "2026-09-27T10:00:00.000Z",
      },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, proposals: [valid] }))
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          proposals: [
            { ...valid, providerOperation: { ...valid.providerOperation, status: "invented" } },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const client = createRuntimeClient({ ...options, fetch: fetcher });
    expect((await client.admin.actions()).proposals[0]?.terminalAt).toBeNull();
    await expect(client.admin.actions()).rejects.toMatchObject({ code: "invalid_response" });
    await expect(client.admin.reconcileAction("action")).rejects.toMatchObject({
      code: "invalid_response",
    });
    const spec = publicApiOpenApi("1.0.0");
    const root = "/v1/workspaces/{workspaceId}/agents/{agentId}/workbench/actions";
    expect(spec.paths[`${root}/{id}/execute`]!.post!.responses).toHaveProperty("202");
    expect(spec.paths[`${root}/{id}/reconcile`]!.post!.responses).toHaveProperty("202");
    expect(spec.paths[root]!.get!.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "limit", in: "query" })]),
    );
  });

  it("validates typed state replies and publishes target and retry concurrency contracts", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true, records: [{ data: {} }] }));
    const client = createRuntimeClient({ ...options, fetch: fetcher });
    await expect(
      client.state.records({ target: "simulation", namespace: "capacity", kind: "pool" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    const spec = publicApiOpenApi("1.0.0");
    const root = "/v1/workspaces/{workspaceId}/agents/{agentId}/workbench/state";
    expect(spec.paths[`${root}/records`]!.get!.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "target", in: "query", required: true }),
        expect.objectContaining({ name: "limit", in: "query", required: false }),
      ]),
    );
    expect(
      spec.paths[`${root}/deliveries/{id}/retry`]!.post!.requestBody?.content["application/json"]
        .schema,
    ).toMatchObject({ required: ["target", "expectedAttempts"], additionalProperties: false });
    expect(spec.paths[`${root}/deliveries/{id}/retry`]!.post!.responses).toHaveProperty("202");
  });
  it("rejects malformed canonical transcripts before a renderer sees them", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        ok: true,
        messages: [{ id: "m", role: "assistant", content: [{ type: "text", text: 42 }] }],
      }),
    );
    await expect(
      createRuntimeClient({ ...options, fetch: fetcher }).threads.messages("thread1"),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("targets the active agent through /v1/me and publishes those operations", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ ok: true, queryId: "pack.summary", output: { count: 1 } }),
    );
    const client = createRuntimeClient({ ...options, target: "me", fetch: fetcher });
    await client.queries.run("pack.summary", { limit: 5 });
    expect(String(fetcher.mock.calls[0]![0])).toMatch(/\/v1\/me\/queries\/pack\.summary$/);
    const spec = publicApiOpenApi("1.0.0");
    const route = spec.paths["/v1/me/queries/{id}"]!.post!;
    expect(route.parameters.map((parameter) => parameter.name)).toEqual(["id"]);
    expect(spec.paths["/v1/me/webhooks/{id}/deliveries/{deliveryId}/retry"]!.post).toBeDefined();
  });
  it("publishes real chat acceptance status and request bounds in OpenAPI", () => {
    const spec = publicApiOpenApi("1.0.0");
    const route =
      spec.paths["/v1/workspaces/{workspaceId}/agents/{agentId}/chat/threads/{id}/turns"]!;
    expect(route.post!.responses).toHaveProperty("202");
    expect(route.post!.requestBody?.content["application/json"].schema).toMatchObject({
      properties: { text: { maxLength: 8000 } },
    });
  });
  it("accepts commands without connecting any observation channel and fixes their scope", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { ok: true, status: "accepted", messageId: "turn1", threadId: "thread1" },
        { status: 202 },
      ),
    );
    const target = { workspaceId: "original", agentId: "original-agent" };
    const transport = createFetchChatTransport({
      ...options,
      target,
      threadId: "thread1",
      fetch: fetcher,
    });
    target.workspaceId = "changed-by-another-client";
    expect(await transport.send({ clientTurnId: "turn1", text: "hello" })).toEqual({
      messageId: "turn1",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://runtime.example/v1/workspaces/original/agents/original-agent/chat/threads/thread1/turns",
    );
    expect(new Headers(init.headers).get("idempotency-key")).toBe("turn1");
  });
  it("renews tokens once after rejection, preserving the command identity", async () => {
    const tokens = vi.fn(async ({ forceRefresh }: { forceRefresh: boolean }) =>
      forceRefresh ? "fresh" : "expired",
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: "expired" }, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({ ok: true, messageId: "turn1", status: "accepted", threadId: "thread1" }),
      );
    const client = createRuntimeClient({ ...options, getAccessToken: tokens, fetch: fetcher });
    await client.threads.submit("thread1", "hello", "turn1");
    expect(tokens.mock.calls.map(([input]) => input.forceRefresh)).toEqual([false, true]);
    expect(new Headers(fetcher.mock.calls[1]![1]!.headers).get("authorization")).toBe(
      "Bearer fresh",
    );
    expect(new Headers(fetcher.mock.calls[1]![1]!.headers).get("idempotency-key")).toBe("turn1");
  });
  it("does not retry failed mutations after an ambiguous server outcome", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "failure" }, { status: 500 }));
    await expect(
      createRuntimeClient({ ...options, fetch: fetcher }).threads.submit(
        "thread1",
        "hello",
        "turn1",
      ),
    ).rejects.toMatchObject({ status: 500 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("observes reset instructions and sends a replay cursor over Fetch SSE", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response('event: reset\ndata: {"reason":"cursor_expired"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const stream = createRuntimeClient({ ...options, fetch: fetcher }).events({ after: "expired" });
    const iterator = stream[Symbol.asyncIterator]();
    const event = await iterator.next();
    expect(event.value).toMatchObject({ type: "reset", data: { reason: "cursor_expired" } });
    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get("last-event-id")).toBe("expired");
    stream.close();
    await iterator.return(undefined);
  });
  it("omits private reasoning and provider fields from public transcript blocks", () => {
    expect(
      toPublicMessage({
        id: "m",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "private" },
          { type: "text", text: "public", providerMetadata: { secret: "hidden" } },
        ],
      }),
    ).toEqual({ id: "m", role: "assistant", content: [{ type: "text", text: "public" }] });
  });
});
