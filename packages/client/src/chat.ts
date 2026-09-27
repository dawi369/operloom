import type { ChatSessionResponse, Id, WorkbenchSessionEvent } from "./contracts/index.js";

export const workbenchChatProtocolVersion = 2 as const;

export type WorkbenchChatConnectionDescriptor = NonNullable<ChatSessionResponse["connection"]> & {
  chatProtocolVersion: typeof workbenchChatProtocolVersion;
};

export type WorkbenchChatEvent =
  | { type: "connection"; state: "connecting" | "connected" | "disconnected" }
  | { type: "transcript"; messages: readonly Record<string, unknown>[] }
  | { type: "run"; state: "started" | "completed" | "failed" | "cancelled"; runId?: Id }
  | { type: "error"; code: string; message: string; recoverable: boolean }
  | { type: "replaced"; reason: "agent_handoff" | "token_refresh" };

export type WorkbenchChatTransport = {
  /** Connect the disposable realtime observation channel. */
  connect(): Promise<void>;
  /**
   * Durably accept a turn through the canonical command path.
   *
   * Implementations must not wait for `connect()` before issuing this command.
   * Realtime is an observer of accepted state, never a prerequisite for writes.
   */
  send(input: { clientTurnId: Id; text: string }): Promise<{ messageId: Id }>;
  cancel(): Promise<void>;
  resume(): Promise<void>;
  close(): void;
  subscribe(listener: (event: WorkbenchChatEvent) => void): () => void;
};

export type WorkbenchChatControllerState =
  | "idle"
  | "connecting"
  | "ready"
  | "sending"
  | "running"
  | "paused"
  | "reconnecting"
  | "failed"
  | "replaced"
  | "closed";

export type WorkbenchPendingChatTurn = {
  clientTurnId: Id;
  text: string;
  createdAt: string;
};

export type WorkbenchPendingTurnStore = {
  get(): Promise<WorkbenchPendingChatTurn | null>;
  put(turn: WorkbenchPendingChatTurn): Promise<void>;
  clear(clientTurnId: Id): Promise<void>;
};

export type WorkbenchChatControllerSnapshot = {
  state: WorkbenchChatControllerState;
  pendingTurn: WorkbenchPendingChatTurn | null;
  error: { code: string; message: string; recoverable: boolean } | null;
};

export type WorkbenchChatController = {
  connect(): Promise<void>;
  submit(input: {
    clientTurnId: Id;
    text: string;
    signal?: AbortSignal;
  }): Promise<{ messageId: Id; assistantText: string }>;
  acceptSessionEvent(event: WorkbenchSessionEvent): void;
  cancel(): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  replace(reason: "agent_handoff" | "token_refresh"): void;
  close(): void;
  snapshot(): WorkbenchChatControllerSnapshot;
  subscribe(listener: (snapshot: WorkbenchChatControllerSnapshot) => void): () => void;
};

type ActiveTurn = {
  turn: WorkbenchPendingChatTurn;
  baselineAssistantId: string | null;
  messageId: string | null;
  assistant: { id: string; text: string } | null;
  terminal: "completed" | "failed" | "cancelled" | null;
  resolve(value: { messageId: Id; assistantText: string }): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
};

const assistantFromTranscript = (messages: readonly Record<string, unknown>[]) => {
  const candidate = [...messages].reverse().find((message) => message.role === "assistant");
  if (!candidate || typeof candidate.id !== "string" || !Array.isArray(candidate.parts))
    return null;
  const text = candidate.parts
    .map((part) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("")
    .trim();
  return text ? { id: candidate.id, text } : null;
};

const sessionRunState = (event: WorkbenchSessionEvent) => {
  if (event.type === "chat.run.started") return "started" as const;
  if (event.type === "chat.run.completed") return "completed" as const;
  if (event.type === "chat.run.failed") return "failed" as const;
  return null;
};

export const createWorkbenchChatController = (input: {
  transport: WorkbenchChatTransport;
  pendingTurns: WorkbenchPendingTurnStore;
  timeoutMs?: number;
}): WorkbenchChatController => {
  const listeners = new Set<(snapshot: WorkbenchChatControllerSnapshot) => void>();
  let state: WorkbenchChatControllerState = "idle";
  let pendingTurn: WorkbenchPendingChatTurn | null = null;
  let error: WorkbenchChatControllerSnapshot["error"] = null;
  let active: ActiveTurn | null = null;
  let latestAssistantId: string | null = null;

  const snapshot = () => ({ state, pendingTurn, error });
  const publish = (next: WorkbenchChatControllerState, nextError = error) => {
    state = next;
    error = nextError;
    const value = snapshot();
    listeners.forEach((listener) => listener(value));
  };
  const settle = () => {
    if (!active?.terminal) return;
    if (active.terminal === "completed" && active.assistant) {
      clearTimeout(active.timeout);
      const completed = active;
      const assistantText = active.assistant.text;
      active = null;
      publish("ready", null);
      completed.resolve({
        messageId: completed.messageId ?? completed.turn.clientTurnId,
        assistantText,
      });
      return;
    }
    if (active.terminal === "failed" || active.terminal === "cancelled") {
      clearTimeout(active.timeout);
      const terminal = active.terminal;
      const failed = active;
      active = null;
      publish(terminal === "cancelled" ? "ready" : "failed", error);
      failed.reject(
        new Error(terminal === "cancelled" ? "Chat response cancelled." : "Chat failed."),
      );
    }
  };

  const stateWhileObserving = () => {
    if (state === "sending" || state === "running" || state === "paused") return state;
    return state === "reconnecting" ? "reconnecting" : "connecting";
  };

  const unsubscribeTransport = input.transport.subscribe((event) => {
    if (event.type === "connection") {
      if (event.state === "connecting") publish(stateWhileObserving());
      if (event.state === "connected") publish(active ? "running" : "ready", null);
      if (event.state === "disconnected" && state !== "paused" && state !== "closed") {
        publish("reconnecting");
      }
      return;
    }
    if (event.type === "transcript") {
      const assistant = assistantFromTranscript(event.messages);
      if (assistant) latestAssistantId = assistant.id;
      if (active && assistant?.id !== active.baselineAssistantId) active.assistant = assistant;
      settle();
      return;
    }
    if (event.type === "run" && active) {
      if (event.state === "started") publish("running", null);
      else active.terminal = event.state;
      settle();
      return;
    }
    if (event.type === "error") {
      const nextError = {
        code: event.code,
        message: event.message,
        recoverable: event.recoverable,
      };
      const recoverableState = active ? (active.messageId ? "running" : "sending") : "reconnecting";
      publish(event.recoverable ? recoverableState : "failed", nextError);
      if (!event.recoverable && active) {
        active.terminal = "failed";
        settle();
      }
      return;
    }
    if (event.type === "replaced") publish("replaced", null);
  });

  const connect = async () => {
    if (state === "closed") throw new Error("Chat controller is closed.");
    publish(stateWhileObserving(), null);
    try {
      await input.transport.connect();
      if (state !== "paused") publish(active ? "running" : "ready", null);
    } catch (cause) {
      publish(active ? (active.messageId ? "running" : "sending") : "reconnecting", {
        code: "chat_connect_failed",
        message: cause instanceof Error ? cause.message : "Chat connection failed.",
        recoverable: true,
      });
      throw cause;
    }
  };

  const submit: WorkbenchChatController["submit"] = async ({ clientTurnId, text, signal }) => {
    if (active) throw new Error("One chat turn is already running.");
    const stored = await input.pendingTurns.get();
    if (stored && (stored.clientTurnId !== clientTurnId || stored.text !== text)) {
      throw new Error("One message is already waiting to send.");
    }
    const turn = stored ?? { clientTurnId, text, createdAt: new Date().toISOString() };
    if (!stored) await input.pendingTurns.put(turn);
    pendingTurn = turn;
    publish("sending", null);

    // Observation starts concurrently, but durable command acceptance must not
    // be blocked by WebSocket identity, reconnect, or platform socket support.
    void connect().catch(() => undefined);

    return await new Promise<{ messageId: Id; assistantText: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!active) return;
        active = null;
        publish("reconnecting", {
          code: "chat_response_timeout",
          message: "The response is still running. Reopen this chat to continue.",
          recoverable: true,
        });
        reject(new Error("The response is still running. Reopen this chat to continue."));
      }, input.timeoutMs ?? 180_000);
      active = {
        turn,
        baselineAssistantId: latestAssistantId,
        messageId: null,
        assistant: null,
        terminal: null,
        resolve,
        reject,
        timeout,
      };
      signal?.addEventListener(
        "abort",
        () => {
          void input.transport.cancel();
          if (active) {
            active.terminal = "cancelled";
            settle();
          }
        },
        { once: true },
      );
      void input.transport
        .send(turn)
        .then(async ({ messageId }) => {
          if (!active) return;
          active.messageId = messageId;
          await input.pendingTurns.clear(turn.clientTurnId);
          pendingTurn = null;
          publish("running", null);
        })
        .catch((cause: unknown) => {
          if (!active) return;
          clearTimeout(active.timeout);
          active = null;
          publish("failed", {
            code: "chat_send_failed",
            message: cause instanceof Error ? cause.message : "Chat send failed.",
            recoverable: true,
          });
          reject(cause instanceof Error ? cause : new Error("Chat send failed."));
        });
    });
  };

  return {
    connect,
    submit,
    acceptSessionEvent(event) {
      const runState = sessionRunState(event);
      if (!runState || !active) return;
      const clientTurnId = event.data.clientTurnId;
      if (typeof clientTurnId === "string" && clientTurnId !== active.turn.clientTurnId) return;
      const threadRunId = typeof event.data.runId === "string" ? event.data.runId : undefined;
      if (runState === "started") publish("running", null);
      else active.terminal = runState;
      if (threadRunId && !active.messageId) active.messageId = active.turn.clientTurnId;
      settle();
    },
    async cancel() {
      await input.transport.cancel();
      if (active) {
        active.terminal = "cancelled";
        settle();
      }
    },
    pause() {
      input.transport.close();
      publish("paused");
    },
    async resume() {
      publish("reconnecting", null);
      await input.transport.resume();
      publish(active ? "running" : "ready", null);
    },
    replace(reason) {
      input.transport.close();
      publish("replaced", null);
      void reason;
    },
    close() {
      unsubscribeTransport();
      input.transport.close();
      if (active) {
        clearTimeout(active.timeout);
        active.reject(new Error("Chat controller closed."));
        active = null;
      }
      publish("closed", null);
      listeners.clear();
    },
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
  };
};
