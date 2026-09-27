import { chatRuntimeStateLabel, chatRuntimeStateTone } from "./chat-runtime-display";
import type {
  ChatRuntimeSummary,
  ChatSessionResponse,
  CloudflareAdminSummaryResponse,
  WorkbenchSessionEvent,
} from "./workbench-types";
import { isVisibleThread, type PendingSessionTransition } from "./chat-session-state";

type RuntimeConnectionSnapshot = {
  threadId?: string;
  agentId?: string;
  workspaceId?: string;
} | null;

export type RuntimeSource =
  | "connection_error"
  | "cached_shell"
  | "live_session_event"
  | "live_session_stream"
  | "agent_token"
  | "summary"
  | "summary_stale"
  | "connecting";

export type DerivedRuntimeState = {
  chatState?: ChatRuntimeSummary["state"];
  chatLabel: string;
  chatTone?: ReturnType<typeof chatRuntimeStateTone>;
  source: RuntimeSource;
  sourceLabel: string;
  cloudflareStatus: string;
  cloudflareTone?: ReturnType<typeof chatRuntimeStateTone>;
  summaryIsFresh: boolean;
  summaryIsStale: boolean;
  liveEventState?: ChatRuntimeSummary["state"];
  activeThreadTitle?: string;
  activeThreadId?: string;
  activeAgentLabel?: string;
  modelLabel?: string;
  errorMessage?: string;
};

export const liveChatStateFromEvent = (
  event?: WorkbenchSessionEvent | null,
): ChatRuntimeSummary["state"] | undefined => {
  if (event?.type === "chat.run.started") return "running";
  if (event?.type === "chat.run.completed") return "completed";
  if (event?.type === "chat.run.failed") return "failed";
  return undefined;
};

const readTime = (value?: string | null) => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const eventThreadId = (event?: WorkbenchSessionEvent | null) => {
  const threadId = event?.data.threadId;
  return typeof threadId === "string" ? threadId : null;
};

export const isAdminSummaryFreshForLiveEvent = (
  summary: CloudflareAdminSummaryResponse["summary"] | null | undefined,
  event: WorkbenchSessionEvent | null | undefined,
) => {
  const eventTime = readTime(event?.createdAt);
  if (!eventTime) return true;
  const summaryTime = readTime(summary?.generatedAt);
  return Boolean(summaryTime && summaryTime >= eventTime);
};

export const describeSummarySync = (input: {
  isStale: boolean;
  isLoading: boolean;
  syncStatus: "idle" | "catching_up" | "exhausted";
}) => {
  if (!input.isStale) return null;
  if (input.isLoading || input.syncStatus === "catching_up") {
    return {
      message: "Refreshing runtime details.",
      canRefresh: false,
    };
  }
  return input.syncStatus === "exhausted"
    ? { message: "Runtime details refresh is delayed.", canRefresh: true }
    : { message: "Runtime details are out of date.", canRefresh: true };
};

export const deriveRuntimeState = (input: {
  session: ChatSessionResponse | null;
  connection: RuntimeConnectionSnapshot;
  error: string | null;
  isSessionStreamConnected: boolean;
  latestSessionEvent: WorkbenchSessionEvent | null;
  latestChatRunEvent?: WorkbenchSessionEvent | null;
  pending: PendingSessionTransition | null;
  isInitialLoading: boolean;
  summary?: CloudflareAdminSummaryResponse["summary"] | null;
  summaryError?: string | null;
  authLoading?: boolean;
}): DerivedRuntimeState => {
  const summary = input.summary ?? null;
  const summaryIsFresh = isAdminSummaryFreshForLiveEvent(summary, input.latestSessionEvent);
  const summaryIsStale = Boolean(summary && !summaryIsFresh);
  const activeThread = isVisibleThread(input.session?.activeThread)
    ? (input.session?.activeThread ?? null)
    : null;
  const latestChatRunEvent = input.latestChatRunEvent ?? input.latestSessionEvent;
  const latestChatThreadId = eventThreadId(latestChatRunEvent);
  const latestChatEventMatchesThread = activeThread?.threadId
    ? latestChatThreadId === activeThread.threadId
    : latestChatRunEvent === input.latestSessionEvent;
  const liveEventState =
    latestChatEventMatchesThread && !isAdminSummaryFreshForLiveEvent(summary, latestChatRunEvent)
      ? liveChatStateFromEvent(latestChatRunEvent)
      : undefined;
  const summaryState = summary?.chatRuntime?.state;
  const chatState = liveEventState ?? summaryState;
  const isLiveSummarySyncing = summaryIsStale && input.isSessionStreamConnected && !chatState;
  const chatLabel =
    input.pending?.type === "create" || input.pending?.type === "activate"
      ? "Opening"
      : isLiveSummarySyncing
        ? "Syncing"
        : chatRuntimeStateLabel(chatState);
  const chatTone = isLiveSummarySyncing ? "running" : chatRuntimeStateTone(chatState);

  const activeAgent = input.session?.activeAgent ?? summary?.activeAgent ?? null;
  const summaryThread = summary?.chatRuntime?.latestThread ?? null;
  // Historical workflow/tool failures belong in History and the Admin detail
  // projection. They must not degrade the current chat connection indicator.
  const errorMessage = input.error ?? input.summaryError ?? undefined;

  let source: RuntimeSource = "connecting";
  let sourceLabel = "Connecting";
  let cloudflareStatus = "Connecting";
  let cloudflareTone: ReturnType<typeof chatRuntimeStateTone> = "running";

  if (input.error) {
    source = "connection_error";
    sourceLabel = "Connection failed";
    cloudflareStatus = "Connection failed";
    cloudflareTone = "failed";
  } else if (input.session?.isStale) {
    source = "cached_shell";
    sourceLabel = "Cached shell";
    cloudflareStatus = "Cached, refreshing";
    cloudflareTone = "running";
  } else if (liveEventState) {
    source = "live_session_event";
    sourceLabel = "Live session event";
    cloudflareStatus = input.isSessionStreamConnected ? "Live" : "Event received";
    cloudflareTone = chatTone ?? "completed";
  } else if (input.isSessionStreamConnected) {
    source = "live_session_stream";
    sourceLabel = "Live session stream";
    cloudflareStatus = "Live";
    cloudflareTone = "completed";
  } else if (input.connection) {
    source = "agent_token";
    sourceLabel = "Agent token ready";
    cloudflareStatus = "Agent token ready";
    cloudflareTone = "running";
  } else if (summaryIsFresh && summary) {
    source = "summary";
    sourceLabel = "Summary refreshed";
    cloudflareStatus = "Summary refreshed";
    cloudflareTone = chatTone;
  } else if (summaryIsStale) {
    source = "summary_stale";
    sourceLabel = "Summary stale";
    cloudflareStatus = "Summary stale";
    cloudflareTone = "running";
  } else if (input.isInitialLoading || input.authLoading) {
    sourceLabel = "Connecting";
  }

  return {
    chatState,
    chatLabel,
    chatTone,
    source,
    sourceLabel,
    cloudflareStatus,
    cloudflareTone,
    summaryIsFresh,
    summaryIsStale,
    liveEventState,
    activeThreadTitle: activeThread?.title,
    activeThreadId: activeThread?.threadId ?? summaryThread?.threadId,
    activeAgentLabel: activeAgent ? `${activeAgent.name} / ${activeAgent.profile}` : undefined,
    modelLabel: activeAgent?.runtime.model,
    errorMessage,
  };
};
