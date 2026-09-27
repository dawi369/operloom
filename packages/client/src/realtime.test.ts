import { describe, expect, it, vi } from "vitest";

import { createWorkbenchRealtimeAdapter } from "./realtime.js";

const streamResponse = (chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

describe("workbench realtime adapter", () => {
  it("resumes after a cursor and parses split SSE events", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      streamResponse([
        'id: event-2\nevent: action.updated\ndata: {"id":"event-2","type":"action.updated",',
        '"createdAt":"2026-08-05T12:00:00.000Z","data":{"status":"executed"}}\n\n',
      ]),
    );
    const adapter = createWorkbenchRealtimeAdapter({
      baseUrl: "https://workbench.example",
      client: { platform: "ios", version: "0.1.0" },
      fetch: fetcher,
      getAccessToken: async () => "access-token",
    });
    const subscription = adapter.subscribeSession({ after: "event-1" });
    const events = [];
    for await (const event of subscription.events) events.push(event);

    expect(fetcher.mock.calls[0]![0]).toBe(
      "https://workbench.example/api/workbench/chat-session/stream?after=event-1",
    );
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("authorization")).toBe(
      "Bearer access-token",
    );
    expect(events).toEqual([expect.objectContaining({ id: "event-2", type: "action.updated" })]);
  });

  it("rejects malformed public events", async () => {
    const adapter = createWorkbenchRealtimeAdapter({
      baseUrl: "https://workbench.example",
      client: { platform: "android", version: "0.1.0" },
      fetch: async () => streamResponse(['data: {"id":"missing-fields"}\n\n']),
    });
    const subscription = adapter.subscribeSession();
    await expect(async () => {
      for await (const _event of subscription.events) {
        // The malformed event fails before a value is yielded.
      }
    }).rejects.toMatchObject({ code: "invalid_session_event" });
  });
});
