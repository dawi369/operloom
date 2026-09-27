import type { WorkbenchChatEvent, WorkbenchChatTransport } from "./chat.js";
import { createRuntimeClient, type RuntimeClientOptions } from "./runtime-client.js";

/** Fetch only: SSE wakes canonical reads; polling covers outages and transcript changes. */
export const createFetchChatTransport = (
  options: RuntimeClientOptions & { threadId: string; pollIntervalMs?: number },
): WorkbenchChatTransport => {
  const client = createRuntimeClient(options);
  const listeners = new Set<(event: WorkbenchChatEvent) => void>();
  const emit = (event: WorkbenchChatEvent) => {
    for (const listener of listeners) listener(event);
  };
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let lastSnapshot = "";
  let reading: Promise<void> | undefined;
  const refresh = async (signal: AbortSignal) => {
    if (reading) return reading;
    const currentGeneration = generation;
    const operation = (async () => {
      const snapshot = await client.threads.messages(options.threadId, signal);
      if (signal.aborted || currentGeneration !== generation) return;
      const serialized = JSON.stringify(snapshot);
      if (serialized === lastSnapshot) return;
      lastSnapshot = serialized;
      emit({
        type: "transcript",
        messages: snapshot.messages.map((message) => ({
          id: message.id,
          role: message.role,
          parts: message.content
            .filter((block) => block.type === "text")
            .map((block) => ({ type: "text", text: block.text })),
        })),
      });
      if (
        snapshot.run &&
        ["running", "completed", "failed", "cancelled"].includes(snapshot.run.status)
      )
        emit({
          type: "run",
          runId: snapshot.run.id,
          state:
            snapshot.run.status === "running"
              ? "started"
              : (snapshot.run.status as "completed" | "failed" | "cancelled"),
        });
    })();
    reading = operation;
    try {
      await operation;
    } finally {
      if (reading === operation) reading = undefined;
    }
  };
  const close = () => {
    generation++;
    clearTimeout(timer);
    controller?.abort();
    controller = undefined;
    reading = undefined;
  };
  const connect = async () => {
    close();
    const active = new AbortController();
    controller = active;
    lastSnapshot = "";
    emit({ type: "connection", state: "connecting" });
    await refresh(active.signal);
    if (active.signal.aborted) return;
    emit({ type: "connection", state: "connected" });
    const poll = async () => {
      try {
        await refresh(active.signal);
      } catch {
        if (!active.signal.aborted) emit({ type: "connection", state: "disconnected" });
      }
      if (!active.signal.aborted)
        timer = setTimeout(
          () => {
            void poll();
          },
          Math.max(250, options.pollIntervalMs ?? 2000),
        );
    };
    timer = setTimeout(
      () => {
        void poll();
      },
      Math.max(250, options.pollIntervalMs ?? 2000),
    );
    void (async () => {
      try {
        for await (const _event of client.events({ signal: active.signal }))
          await refresh(active.signal);
      } catch {
        /* Polling remains available when streaming or replay is unavailable. */
      }
    })();
  };
  return {
    connect,
    close,
    resume: connect,
    async send(input) {
      const accepted = await client.threads.submit(
        options.threadId,
        input.text,
        input.clientTurnId,
      );
      emit({ type: "run", state: "started" });
      return { messageId: accepted.messageId };
    },
    async cancel() {
      await client.threads.cancel(options.threadId);
      emit({ type: "run", state: "cancelled" });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
