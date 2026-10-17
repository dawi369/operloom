import {
  createFetchChatTransport,
  createWorkbenchChatController,
  type WorkbenchChatControllerSnapshot,
  type WorkbenchPendingChatTurn,
} from "@operloom/client";
import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useMobileAuth } from "../auth/auth-provider";
import { mobileConfig } from "../config";
import { messagesFromChatEvent, type ThreadMessage } from "./chat-messages";

/** One in-flight turn survives a remount so a reconnect can resume it. */
const pendingTurns = new Map<string, WorkbenchPendingChatTurn>();
const pendingStore = (threadId: string) => ({
  get: async () => pendingTurns.get(threadId) ?? null,
  put: async (turn: WorkbenchPendingChatTurn) => {
    pendingTurns.set(threadId, turn);
  },
  clear: async (clientTurnId: string) => {
    if (pendingTurns.get(threadId)?.clientTurnId === clientTurnId) pendingTurns.delete(threadId);
  },
});

export const useChatThread = (threadId: string | null) => {
  const { getAccessToken } = useMobileAuth();
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [snapshot, setSnapshot] = useState<WorkbenchChatControllerSnapshot>({
    state: "idle",
    pendingTurn: null,
    error: null,
  });
  const controllerRef = useRef<ReturnType<typeof createWorkbenchChatController> | null>(null);

  const transport = useMemo(() => {
    if (!threadId) return null;
    return createFetchChatTransport({
      baseUrl: mobileConfig.controlPlaneOrigin,
      target: "me",
      threadId,
      getAccessToken: ({ minValidityMs }) => getAccessToken({ minValidityMs }),
    });
  }, [getAccessToken, threadId]);

  useEffect(() => {
    if (!transport || !threadId) {
      setMessages([]);
      return;
    }
    const controller = createWorkbenchChatController({
      transport,
      pendingTurns: pendingStore(threadId),
    });
    controllerRef.current = controller;
    const unsubscribeTransport = transport.subscribe((event) => {
      const next = messagesFromChatEvent(event);
      if (next) setMessages(next);
    });
    const unsubscribe = controller.subscribe(setSnapshot);
    setSnapshot(controller.snapshot());
    void controller.connect().catch(() => undefined);
    return () => {
      unsubscribe();
      unsubscribeTransport();
      controller.close();
      controllerRef.current = null;
    };
  }, [threadId, transport]);

  const send = useCallback(async (text: string) => {
    const controller = controllerRef.current;
    const trimmed = text.trim();
    if (!controller || !trimmed) return;
    await controller.submit({ clientTurnId: Crypto.randomUUID(), text: trimmed });
  }, []);

  const cancel = useCallback(() => controllerRef.current?.cancel() ?? Promise.resolve(), []);

  return { messages, snapshot, send, cancel };
};
