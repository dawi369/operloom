import { describe, expect, it, vi } from "vitest";

import {
  createWorkbenchChatController,
  type WorkbenchChatEvent,
  type WorkbenchChatTransport,
  type WorkbenchPendingChatTurn,
} from "./chat.js";
import type { WorkbenchSessionEvent } from "./contracts/index.js";

const sessionEvent = (
  type: WorkbenchSessionEvent["type"],
  data: Record<string, unknown>,
): WorkbenchSessionEvent => ({
  id: crypto.randomUUID(),
  type,
  createdAt: new Date().toISOString(),
  data,
});

const harness = (
  initial: WorkbenchPendingChatTurn | null = null,
  options: {
    connect?: WorkbenchChatTransport["connect"];
    send?: WorkbenchChatTransport["send"];
  } = {},
) => {
  const listeners = new Set<(event: WorkbenchChatEvent) => void>();
  let pending = initial;
  const transport: WorkbenchChatTransport = {
    connect: vi.fn(
      options.connect ??
        (async () => {
          listeners.forEach((listener) => listener({ type: "connection", state: "connected" }));
        }),
    ),
    send: vi.fn(options.send ?? (async ({ clientTurnId }) => ({ messageId: clientTurnId }))),
    cancel: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    close: vi.fn(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const controller = createWorkbenchChatController({
    transport,
    pendingTurns: {
      get: async () => pending,
      put: async (turn) => {
        pending = turn;
      },
      clear: async (clientTurnId) => {
        if (pending?.clientTurnId === clientTurnId) pending = null;
      },
    },
    timeoutMs: 1_000,
  });
  const emit = (event: WorkbenchChatEvent) => listeners.forEach((listener) => listener(event));
  return { controller, emit, pending: () => pending, transport };
};

describe("workbench chat controller", () => {
  it("accepts a queued turn once and completes only from a terminal session event", async () => {
    const { controller, emit, pending, transport } = harness();
    const result = controller.submit({ clientTurnId: "turn-1", text: "hello" });
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledTimes(1));
    expect(pending()).toBeNull();
    emit({
      type: "transcript",
      messages: [
        { id: "turn-1", role: "user", parts: [{ type: "text", text: "hello" }] },
        { id: "reply-1", role: "assistant", parts: [{ type: "text", text: "done" }] },
      ],
    });
    let settled = false;
    void result.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    controller.acceptSessionEvent(
      sessionEvent("chat.run.completed", { clientTurnId: "turn-1", runId: "run-1" }),
    );
    await expect(result).resolves.toEqual({ messageId: "turn-1", assistantText: "done" });
  });

  it("accepts the durable command without waiting for realtime observation", async () => {
    const neverConnected = new Promise<void>(() => undefined);
    const { controller, emit, pending, transport } = harness(null, {
      connect: () => neverConnected,
    });
    const result = controller.submit({ clientTurnId: "turn-offline", text: "hello" });

    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(pending()).toBeNull());
    expect(controller.snapshot().state).toBe("running");

    emit({
      type: "transcript",
      messages: [
        { id: "turn-offline", role: "user", parts: [{ type: "text", text: "hello" }] },
        { id: "reply-offline", role: "assistant", parts: [{ type: "text", text: "done" }] },
      ],
    });
    controller.acceptSessionEvent(
      sessionEvent("chat.run.completed", { clientTurnId: "turn-offline", runId: "run-offline" }),
    );
    await expect(result).resolves.toEqual({ messageId: "turn-offline", assistantText: "done" });
  });

  it("keeps durable delivery state visible while realtime observation reconnects", async () => {
    let acceptTurn!: (value: { messageId: string }) => void;
    const sendPending = new Promise<{ messageId: string }>((resolve) => {
      acceptTurn = resolve;
    });
    const { controller, emit, transport } = harness(null, {
      connect: () => new Promise<void>(() => undefined),
      send: () => sendPending,
    });
    const result = controller.submit({ clientTurnId: "turn-slow", text: "hello" });

    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledOnce());
    expect(controller.snapshot().state).toBe("sending");
    emit({
      type: "error",
      code: "chat_connection_failed",
      message: "Live updates are reconnecting.",
      recoverable: true,
    });
    expect(controller.snapshot()).toMatchObject({
      state: "sending",
      error: { code: "chat_connection_failed" },
    });

    acceptTurn({ messageId: "turn-slow" });
    await vi.waitFor(() => expect(controller.snapshot().state).toBe("running"));
    emit({
      type: "transcript",
      messages: [
        { id: "turn-slow", role: "user", parts: [{ type: "text", text: "hello" }] },
        { id: "reply-slow", role: "assistant", parts: [{ type: "text", text: "done" }] },
      ],
    });
    controller.acceptSessionEvent(
      sessionEvent("chat.run.completed", { clientTurnId: "turn-slow", runId: "run-slow" }),
    );
    await expect(result).resolves.toEqual({ messageId: "turn-slow", assistantText: "done" });
  });

  it("replays the same persisted identity but rejects a competing queued turn", async () => {
    const queued = {
      clientTurnId: "turn-queued",
      text: "queued",
      createdAt: new Date().toISOString(),
    };
    const { controller, emit, transport } = harness(queued);
    const result = controller.submit({ clientTurnId: queued.clientTurnId, text: queued.text });
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledWith(queued));
    emit({
      type: "transcript",
      messages: [
        { id: "reply-queued", role: "assistant", parts: [{ type: "text", text: "ready" }] },
      ],
    });
    controller.acceptSessionEvent(
      sessionEvent("chat.run.completed", { clientTurnId: queued.clientTurnId }),
    );
    await expect(result).resolves.toMatchObject({ assistantText: "ready" });

    const competing = harness(queued).controller.submit({
      clientTurnId: "turn-other",
      text: "other",
    });
    await expect(competing).rejects.toThrow("already waiting");
  });

  it("pauses without cancellation and resumes through the transport", async () => {
    const { controller, transport } = harness();
    await controller.connect();
    controller.pause();
    expect(controller.snapshot().state).toBe("paused");
    expect(transport.cancel).not.toHaveBeenCalled();
    await controller.resume();
    expect(transport.resume).toHaveBeenCalledOnce();
    expect(controller.snapshot().state).toBe("ready");
  });

  it("rejects a failed terminal event without promoting success", async () => {
    const { controller, transport } = harness();
    const result = controller.submit({ clientTurnId: "turn-failed", text: "hello" });
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledOnce());
    controller.acceptSessionEvent(
      sessionEvent("chat.run.failed", { clientTurnId: "turn-failed", runId: "run-failed" }),
    );
    await expect(result).rejects.toThrow("Chat failed");
    expect(controller.snapshot().state).toBe("failed");
  });
});
