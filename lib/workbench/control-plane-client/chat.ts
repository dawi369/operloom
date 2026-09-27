import type { Id } from "@/lib/workbench/core-contracts";
import type {
  AgentSwitchTarget,
  ChatRuntimeSummaryResponse,
  ChatSessionResponse,
  ChatThreadResponse,
  ChatThreadStatus,
  ChatThreadsResponse,
} from "@/lib/workbench/workbench-types";
import { requestControlPlane, requestControlPlaneResponse } from "./transport";

export const getChatRuntimeSummary = () =>
  requestControlPlane<ChatRuntimeSummaryResponse>("/chat/runtime-summary");

export const getChatThreads = (limit = 30) =>
  requestControlPlane<ChatThreadsResponse>(`/chat/threads?limit=${encodeURIComponent(limit)}`);

export const getChatThread = (threadId: Id) =>
  requestControlPlane<ChatThreadResponse>(`/chat/threads/${encodeURIComponent(threadId)}`);

export const getChatSession = (input?: { refresh?: "threads" }) =>
  requestControlPlane<ChatSessionResponse>(
    `/chat/session${input?.refresh ? `?refresh=${encodeURIComponent(input.refresh)}` : ""}`,
  );

export const streamChatSessionEvents = async (input?: { after?: string; lastEventId?: string }) => {
  const after = input?.after?.trim();
  const path = `/chat/session/stream${after ? `?after=${encodeURIComponent(after)}` : ""}`;
  return requestControlPlaneResponse(
    path,
    {
      headers: {
        accept: "text/event-stream",
        ...(input?.lastEventId && !after ? { "Last-Event-ID": input.lastEventId } : {}),
      },
    },
    null,
  );
};

export const createChatSessionThread = (input?: { title?: string }) =>
  requestControlPlane<ChatSessionResponse>("/chat/session/threads", {
    method: "POST",
    body: input?.title ? JSON.stringify({ title: input.title }) : undefined,
  });

export const stageChatSessionThread = () =>
  requestControlPlane<ChatSessionResponse>("/chat/session/stage-thread", {
    method: "POST",
  });

export const materializeChatSessionTurn = (input: { message: string; clientTurnId: string }) =>
  requestControlPlane<ChatSessionResponse>("/chat/session/materialize-turn", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const switchChatSessionAgent = (input: {
  agentId: Id;
  target: AgentSwitchTarget;
  threadId?: Id;
}) =>
  requestControlPlane<ChatSessionResponse>("/chat/session/agent-switch", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const getChatSessionThreads = (input?: {
  status?: Extract<ChatThreadStatus, "active" | "archived">;
}) =>
  requestControlPlane<ChatThreadsResponse>(
    `/chat/session/threads${input?.status ? `?status=${encodeURIComponent(input.status)}` : ""}`,
  );

export const activateChatSessionThread = (threadId: Id) =>
  requestControlPlane<ChatSessionResponse>(
    `/chat/session/threads/${encodeURIComponent(threadId)}/activate`,
    { method: "POST" },
  );

export const updateChatSessionThread = (
  threadId: Id,
  input: { title?: string; status?: ChatThreadStatus; fallbackTitle?: string },
) =>
  requestControlPlane<ChatSessionResponse>(
    `/chat/session/threads/${encodeURIComponent(threadId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
