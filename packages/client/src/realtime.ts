import type { WorkbenchSessionEvent } from "./contracts/index.js";
import { WorkbenchClientError, type WorkbenchClientOptions } from "./client.js";
import { isJsonObject } from "./validation.js";

export type SessionSubscriptionInput = {
  after?: string;
  signal?: AbortSignal;
};

export type SessionSubscription = {
  close(): void;
  events: AsyncIterable<WorkbenchSessionEvent>;
};

export type WorkbenchRealtimeAdapter = {
  subscribeSession(input?: SessionSubscriptionInput): SessionSubscription;
};

const parseSessionEvent = (value: unknown): WorkbenchSessionEvent => {
  if (
    !isJsonObject(value) ||
    typeof value.id !== "string" ||
    typeof value.type !== "string" ||
    typeof value.createdAt !== "string" ||
    !isJsonObject(value.data)
  ) {
    throw new WorkbenchClientError({
      code: "invalid_session_event",
      message: "Workbench session event was malformed",
      retryable: true,
      status: 0,
    });
  }
  return value as WorkbenchSessionEvent;
};

const eventData = (block: string) =>
  block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

export const createWorkbenchRealtimeAdapter = (
  options: Pick<WorkbenchClientOptions, "baseUrl" | "client" | "fetch" | "getAccessToken">,
): WorkbenchRealtimeAdapter => ({
  subscribeSession(input = {}) {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const fetcher = options.fetch ?? globalThis.fetch;
    const baseUrl = options.baseUrl.trim().replace(/\/$/, "");
    const after = input.after?.trim();
    const url = `${baseUrl}/api/workbench/chat-session/stream${after ? `?after=${encodeURIComponent(after)}` : ""}`;

    return {
      close() {
        input.signal?.removeEventListener("abort", abortFromCaller);
        controller.abort();
      },
      events: {
        async *[Symbol.asyncIterator]() {
          const token = await options.getAccessToken?.({ minValidityMs: 60_000 });
          const response = await fetcher(url, {
            cache: "no-store",
            credentials: token ? "omit" : "include",
            headers: {
              accept: "text/event-stream",
              ...(token ? { authorization: `Bearer ${token}` } : {}),
              "x-operloom-client-platform": options.client.platform,
              "x-operloom-client-version": options.client.version,
            },
            signal: controller.signal,
          });
          if (!response.ok || !response.body) {
            throw new WorkbenchClientError({
              code: "session_stream_failed",
              message: `Workbench session stream failed (${response.status})`,
              requestId: response.headers.get("x-request-id") ?? undefined,
              retryable: response.status === 0 || response.status >= 500,
              status: response.status,
            });
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          try {
            while (!controller.signal.aborted) {
              const { done, value } = await reader.read();
              buffer += decoder.decode(value, { stream: !done });
              const blocks = buffer.split(/\r?\n\r?\n/);
              buffer = blocks.pop() ?? "";
              for (const block of blocks) {
                const data = eventData(block);
                if (data) yield parseSessionEvent(JSON.parse(data) as unknown);
              }
              if (done) break;
            }
          } finally {
            reader.releaseLock();
            input.signal?.removeEventListener("abort", abortFromCaller);
          }
        },
      },
    };
  },
});
