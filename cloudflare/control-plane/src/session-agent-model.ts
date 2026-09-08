import { workbenchChatProtocolVersion } from "@operloom/workbench-client";

import { toAgentSummary, toAgentRuntimeMetadata } from "./agent-records";
import { signAgentConnectionClaims } from "./agent-connection-token";
import { selectAgent, selectWorkspace } from "./authz-store";
import {
  deriveThreadAgentInstanceName,
  resolveThreadAgentInstanceName,
} from "./chat-agent-connection-context";
import { getLatestChatSession, getOwnedChatThread } from "./chat-boundary-store";
import { parseDataJson } from "./http";
import type { WorkbenchSessionEvent, WorkbenchSessionEventType } from "./session-event-types";
import {
  createId,
  toJson,
  type AgentIdentity,
  type AgentRow,
  type ChatThreadRow,
  type Env,
} from "./types";

export type ChatThreadListRow = ChatThreadRow & {
  latest_run_status: string | null;
  agent_name: string | null;
  agent_description: string | null;
  agent_status: string | null;
  agent_is_default: number | null;
  agent_created_by_user_id: string | null;
  agent_data_json: string | null;
  agent_created_at: string | null;
  agent_updated_at: string | null;
};

export type CoordinatorAction =
  | "get"
  | "list"
  | "create"
  | "stageThread"
  | "materializeTurn"
  | "activate"
  | "update"
  | "switchAgent"
  | "stream"
  | "broadcast";

export type ThreadListStatus = "active" | "archived";

export type ThreadMutationStatus = "active" | "archived" | "deleted";

export type AgentSwitchTarget = "current_thread" | "new_thread";

export type MaterializedThreadStatus = "active" | "draft";

export type SessionTransitionType =
  | "initial"
  | "create"
  | "activate"
  | "agent_handoff"
  | "rename"
  | "archive"
  | "restore"
  | "delete"
  | "token_refresh";

export type ThreadStatusTransition = "archive" | "restore" | "delete";

export type CoordinatorRequest = {
  action: CoordinatorAction;
  identity: AgentIdentity;
  agentHost?: string;
  threadId?: string;
  refresh?: "threads";
  status?: ThreadListStatus;
  title?: string;
  message?: string;
  clientTurnId?: string;
  after?: string;
  update?: {
    title?: string;
    status?: ThreadMutationStatus;
    fallbackTitle?: string;
  };
  agentSwitch?: {
    agentId?: string;
    target?: AgentSwitchTarget;
  };
  event?: Partial<WorkbenchSessionEvent> & {
    type?: WorkbenchSessionEventType;
    data?: Record<string, unknown>;
  };
};

export type SessionContext = {
  agentName: "workbench-thread-chat-agent";
  instanceName: string;
  userId: string;
  threadId: string;
  sessionId: string;
  workspaceId: string;
  agentId: string;
  agentUpdatedAt?: string;
  accountId?: string;
  accountSource?: string;
};

export type SessionSnapshot = {
  revision: number;
  context: SessionContext | null;
  workspace: {
    id: string;
    name: string;
    status: string;
    isDefault: boolean;
  } | null;
  activeAgent: ReturnType<typeof toAgentSummary>;
  activeThread: ReturnType<typeof toThreadSummary> | null;
  threads: Array<ReturnType<typeof toThreadSummary>>;
  agentHandoff?: AgentHandoffSummary | null;
};

export type SessionResponseOptions = {
  partial?: boolean;
  threadsRefreshRecommended?: boolean;
  transition?: { type: SessionTransitionType; startedAt?: string };
  stagedThread?: { threadId: string; sessionId: string; expiresAt: string; status: "draft" };
  materializedTurn?: {
    threadId: string;
    status: "accepted";
    messageId?: string;
    duplicate?: boolean;
  };
  agentHandoff?: AgentHandoffSummary | null;
};

export type AgentHandoffSummary = {
  id: string;
  threadId?: string;
  fromAgentId?: string;
  fromAgentName?: string;
  toAgentId: string;
  toAgentName: string;
  target: AgentSwitchTarget;
  createdAt: string;
};

export const tokenTtlSeconds = 5 * 60;

export const chatProtocolVersion = workbenchChatProtocolVersion;

export const stagedThreadTtlMs = 30 * 60 * 1000;

export const sseHeartbeatMs = 15_000;

export const sseEncoder = new TextEncoder();

export const maxMaterializeTurnMessageLength = 8_000;

export const maxAgentHandoffHistory = 20;

export const normalizeAgentSwitchTarget = (target: unknown): AgentSwitchTarget =>
  target === "new_thread" ? "new_thread" : "current_thread";

export const getRequiredSecret = (env: Env) => {
  const secret = env.WORKBENCH_AGENT_CONNECTION_SECRET?.trim();
  if (!secret) throw new Error("WORKBENCH_AGENT_CONNECTION_SECRET is not configured");
  return secret;
};

export const firstUserMessageTitle = (thread: ChatThreadRow) => {
  const upstream = parseDataJson(thread.upstream_json);
  if (typeof upstream.title === "string" && upstream.title.trim()) return upstream.title.trim();
  const messages = Array.isArray(upstream.messages) ? upstream.messages : [];
  const firstUser = messages.find((message) => {
    if (!message || typeof message !== "object") return false;
    const type = "type" in message ? message.type : "role" in message ? message.role : undefined;
    return type === "human" || type === "user";
  });
  if (!firstUser || typeof firstUser !== "object" || !("content" in firstUser)) return "New chat";

  const content = firstUser.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => {
              if (!part || typeof part !== "object") return "";
              if ("text" in part && typeof part.text === "string") return part.text;
              if ("content" in part && typeof part.content === "string") return part.content;
              return "";
            })
            .filter(Boolean)
            .join(" ")
        : "";
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "New chat";
  return compact.length > 56 ? `${compact.slice(0, 53)}...` : compact;
};

export const formatThreadTimeTitle = (date: Date = new Date()) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);

export const titleFromInput = (title: string | undefined) => {
  if (title === undefined) return undefined;
  const trimmed = title.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
};

export const normalizeMaterializeMessage = (message: unknown) => {
  if (typeof message !== "string") return null;
  const normalized = message.replace(/\r\n/g, "\n").trim();
  if (!normalized || normalized.length > maxMaterializeTurnMessageLength) return null;
  return normalized;
};

export const messageCount = (thread: ChatThreadRow) => {
  const upstream = parseDataJson(thread.upstream_json);
  if (typeof upstream.messageCount === "number" && Number.isFinite(upstream.messageCount)) {
    return upstream.messageCount;
  }
  return Array.isArray(upstream.messages) ? upstream.messages.length : 0;
};

export const isAgentHandoffSummary = (value: unknown): value is AgentHandoffSummary => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AgentHandoffSummary>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.toAgentId === "string" &&
    typeof candidate.toAgentName === "string" &&
    (candidate.target === "current_thread" || candidate.target === "new_thread") &&
    typeof candidate.createdAt === "string"
  );
};

export const agentHandoffsFromThread = (thread: ChatThreadRow): AgentHandoffSummary[] => {
  const upstream = parseDataJson(thread.upstream_json);
  if (!Array.isArray(upstream.agentHandoffs)) return [];
  return upstream.agentHandoffs.filter(isAgentHandoffSummary).slice(-maxAgentHandoffHistory);
};

export const latestAgentHandoff = (thread: ChatThreadRow): AgentHandoffSummary | null => {
  const handoffs = agentHandoffsFromThread(thread);
  return handoffs.at(-1) ?? null;
};

export const appendAgentHandoffToUpstream = (
  upstream: Record<string, unknown>,
  handoff: AgentHandoffSummary,
) => ({
  ...upstream,
  agentHandoff: handoff,
  agentHandoffs: [
    ...(Array.isArray(upstream.agentHandoffs)
      ? upstream.agentHandoffs.filter(isAgentHandoffSummary)
      : []),
    handoff,
  ].slice(-maxAgentHandoffHistory),
});

export const rowAgent = (row: ChatThreadListRow): AgentRow | null => {
  if (!row.agent_name || !row.agent_status) return null;
  return {
    id: row.agent_id,
    workspace_id: row.workspace_id,
    name: row.agent_name,
    description: row.agent_description,
    status: row.agent_status,
    is_default: row.agent_is_default ?? 0,
    created_by_user_id: row.agent_created_by_user_id ?? row.user_id,
    data_json: row.agent_data_json ?? "{}",
    created_at: row.agent_created_at ?? row.created_at,
    updated_at: row.agent_updated_at ?? row.updated_at,
  };
};

export const toThreadSummary = (
  env: Env,
  thread: ChatThreadRow | ChatThreadListRow,
  input: { activeThreadId?: string | null; activeAgentId: string; latestRunStatus?: string | null },
) => {
  const maybeListRow = thread as Partial<ChatThreadListRow>;
  const agent = "agent_name" in maybeListRow ? rowAgent(thread as ChatThreadListRow) : null;
  return {
    threadId: thread.thread_id,
    sessionId: thread.session_id,
    agentId: thread.agent_id,
    agent: agent ? toAgentSummary(env, agent, input.activeAgentId) : null,
    status: thread.status,
    title: firstUserMessageTitle(thread),
    createdAt: thread.created_at,
    updatedAt: thread.updated_at,
    lastSeenAt: thread.last_seen_at,
    isActive: input.activeThreadId === thread.thread_id,
    agentHandoff: latestAgentHandoff(thread),
    latestRunStatus:
      input.latestRunStatus ??
      ("latest_run_status" in maybeListRow
        ? (maybeListRow.latest_run_status ?? undefined)
        : undefined),
    messageCount: messageCount(thread),
  };
};

export const toActiveThreadSummary = (
  env: Env,
  thread: ChatThreadRow,
  agent: AgentRow,
  activeThreadId: string,
) => ({
  ...toThreadSummary(env, thread, {
    activeThreadId,
    activeAgentId: agent.id,
  }),
  agent: toAgentSummary(env, agent, agent.id),
});

export const mergeActiveThread = (
  threads: SessionSnapshot["threads"],
  activeThread: ReturnType<typeof toThreadSummary>,
) => {
  const seen = new Set<string>();
  const merged = [
    activeThread,
    ...threads.map((thread) => ({
      ...thread,
      isActive: thread.threadId === activeThread.threadId,
    })),
  ].filter((thread) => {
    if (seen.has(thread.threadId)) return false;
    seen.add(thread.threadId);
    return true;
  });
  return merged.slice(0, 30);
};

export const workspaceSummary = async (
  env: Env,
  workspaceId: string,
): Promise<SessionSnapshot["workspace"]> => {
  const workspace = await selectWorkspace(env, workspaceId);
  return workspace
    ? {
        id: workspace.id,
        name: workspace.name,
        status: workspace.status,
        isDefault: workspace.is_default === 1,
      }
    : null;
};

export const listWorkspaceThreads = async (
  env: Env,
  identity: AgentIdentity,
  activeThreadId?: string,
  status: ThreadListStatus = "active",
) => {
  const threads = await env.DB.prepare(
    `SELECT t.thread_id, t.session_id, t.user_id, t.workspace_id, t.agent_id, t.status,
            t.upstream_json, t.created_at, t.updated_at, t.last_seen_at,
            a.name AS agent_name,
            a.description AS agent_description,
            a.status AS agent_status,
            a.is_default AS agent_is_default,
            a.created_by_user_id AS agent_created_by_user_id,
            a.data_json AS agent_data_json,
            a.created_at AS agent_created_at,
            a.updated_at AS agent_updated_at,
            (
              SELECT r.status
              FROM chat_runs r
              WHERE r.user_id = t.user_id
                AND r.workspace_id = t.workspace_id
                AND r.thread_id = t.thread_id
              ORDER BY r.updated_at DESC, r.started_at DESC
              LIMIT 1
            ) AS latest_run_status
     FROM chat_threads t
     LEFT JOIN agents a ON a.id = t.agent_id AND a.workspace_id = t.workspace_id
     WHERE t.user_id = ? AND t.workspace_id = ? AND t.status = ?
     ORDER BY t.created_at DESC, t.thread_id DESC
     LIMIT 30`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, status)
    .all<ChatThreadListRow>();

  return threads.results.map((thread) =>
    toThreadSummary(env, thread, {
      activeThreadId,
      activeAgentId: identity.agentId,
    }),
  );
};

export const createThreadContext = async (
  env: Env,
  identity: AgentIdentity,
  sessionId: string,
  title?: string,
  options: { status?: MaterializedThreadStatus; draftExpiresAt?: string } = {},
) => {
  const activeAgent = await selectAgent(env, identity.agentId, identity.scope.workspaceId);
  if (!activeAgent || activeAgent.status !== "active") {
    throw new Error("Agent is not active");
  }

  const timestamp = new Date().toISOString();
  const threadTitle = titleFromInput(title) ?? formatThreadTimeTitle(new Date(timestamp));
  const status = options.status ?? "active";
  const threadId = createId("cf-thread");
  const instanceName = await deriveThreadAgentInstanceName({
    userId: identity.scope.userId,
    workspaceId: identity.scope.workspaceId,
    threadId,
  });
  const upstream = {
    source: "cloudflare-agent-chat",
    runtime: "cloudflare-agent-chat",
    title: threadTitle,
    threadId,
    instanceName,
    agent: toAgentRuntimeMetadata(env, activeAgent, identity.agentId),
    ...(status === "draft"
      ? {
          draft: true,
          stagedAt: timestamp,
          stageExpiresAt: options.draftExpiresAt,
        }
      : {}),
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO chat_threads (
         thread_id, session_id, user_id, workspace_id, agent_id, status, upstream_json,
         created_at, updated_at, last_seen_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         session_id = excluded.session_id,
         status = excluded.status,
         upstream_json = excluded.upstream_json,
         updated_at = excluded.updated_at,
         last_seen_at = excluded.last_seen_at`,
    ).bind(
      threadId,
      sessionId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      status,
      toJson(upstream),
      timestamp,
      timestamp,
      timestamp,
    ),
    env.DB.prepare(
      `UPDATE chat_sessions
       SET active_thread_id = ?,
           last_seen_at = ?,
           updated_at = ?
       WHERE user_id = ? AND workspace_id = ? AND session_id = ?`,
    ).bind(
      threadId,
      timestamp,
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      sessionId,
    ),
  ]);
  const thread: ChatThreadRow = {
    thread_id: threadId,
    session_id: sessionId,
    user_id: identity.scope.userId,
    workspace_id: identity.scope.workspaceId,
    agent_id: identity.agentId,
    status,
    upstream_json: toJson(upstream),
    created_at: timestamp,
    updated_at: timestamp,
    last_seen_at: timestamp,
  };

  return { activeAgent, thread, instanceName };
};

export const sessionContext = async (
  identity: AgentIdentity,
  input: { thread: ChatThreadRow; agent: AgentRow; accountId?: string; accountSource?: string },
): Promise<SessionContext> => ({
  agentName: "workbench-thread-chat-agent",
  instanceName: await resolveThreadAgentInstanceName(input.thread),
  userId: identity.scope.userId,
  threadId: input.thread.thread_id,
  sessionId: input.thread.session_id,
  workspaceId: identity.scope.workspaceId,
  agentId: input.agent.id,
  agentUpdatedAt: input.agent.updated_at,
  accountId: input.accountId,
  accountSource: input.accountSource,
});

export const buildSnapshot = async (
  env: Env,
  identity: AgentIdentity,
  input: { activeThread?: ChatThreadRow; activeAgent?: AgentRow; revision: number },
): Promise<SessionSnapshot> => {
  const workspace = await selectWorkspace(env, identity.scope.workspaceId);
  const latestSession = input.activeThread ? null : await getLatestChatSession(env, identity.scope);
  let thread =
    input.activeThread ??
    (latestSession?.active_thread_id
      ? await getOwnedChatThread(env, identity.scope, latestSession.active_thread_id)
      : null);
  if (thread?.status !== "active" && thread?.status !== "draft") thread = null;
  let agent =
    input.activeAgent ?? (await selectAgent(env, identity.agentId, identity.scope.workspaceId));

  if (!agent || agent.status !== "active") {
    throw new Error("Agent is not active");
  }

  if (thread && thread.agent_id !== agent.id) {
    const threadAgent = await selectAgent(env, thread.agent_id, identity.scope.workspaceId);
    if (!threadAgent || threadAgent.status !== "active") {
      throw new Error("Agent is not active");
    }
    agent = threadAgent;
  }

  const activeIdentity = { ...identity, agentId: agent.id };
  const threads = await listWorkspaceThreads(env, activeIdentity, thread?.thread_id);
  const activeThread = thread
    ? (threads.find((candidate) => candidate.threadId === thread.thread_id) ??
      toThreadSummary(env, thread, {
        activeThreadId: thread.thread_id,
        activeAgentId: agent.id,
      }))
    : null;
  const context = thread
    ? await sessionContext(activeIdentity, {
        thread,
        agent,
        accountId: identity.accountId,
        accountSource: identity.accountSource,
      })
    : null;

  return {
    revision: input.revision,
    context,
    workspace: workspace
      ? {
          id: workspace.id,
          name: workspace.name,
          status: workspace.status,
          isDefault: workspace.is_default === 1,
        }
      : null,
    activeAgent: toAgentSummary(env, agent, agent.id),
    activeThread,
    threads,
    agentHandoff: activeThread?.agentHandoff ?? null,
  };
};

export const responseFromSnapshot = async (
  env: Env,
  agentHost: string,
  snapshot: SessionSnapshot,
  options: SessionResponseOptions = {},
) => {
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + tokenTtlSeconds;
  const connection = snapshot.context
    ? {
        token: await signAgentConnectionClaims(getRequiredSecret(env), {
          v: 1,
          exp: expiresAtSeconds,
          nonce: crypto.randomUUID(),
          userId: snapshot.context.userId,
          accountId: snapshot.context.accountId,
          accountSource: snapshot.context.accountSource,
          workspaceId: snapshot.context.workspaceId,
          agentId: snapshot.context.agentId,
          agentUpdatedAt: snapshot.context.agentUpdatedAt,
          threadId: snapshot.context.threadId,
          sessionId: snapshot.context.sessionId,
          instanceName: snapshot.context.instanceName,
          runtime: "cloudflare-agent-chat",
        }),
        expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
      }
    : null;
  return {
    ok: true,
    revision: snapshot.revision,
    workspace: snapshot.workspace,
    activeAgent: snapshot.activeAgent,
    activeThread: snapshot.activeThread,
    threads: snapshot.threads,
    agentHandoff: options.agentHandoff ?? snapshot.agentHandoff ?? null,
    connection: snapshot.context
      ? {
          chatProtocolVersion,
          agentHost,
          agentName: snapshot.context.agentName,
          instanceName: snapshot.context.instanceName,
          token: connection!.token,
          expiresAt: connection!.expiresAt,
          threadId: snapshot.context.threadId,
          sessionId: snapshot.context.sessionId,
          workspaceId: snapshot.context.workspaceId,
          agentId: snapshot.context.agentId,
        }
      : undefined,
    expiresAt: connection?.expiresAt,
    partial: options.partial,
    threadsRefreshRecommended: options.threadsRefreshRecommended,
    transition: options.transition,
    stagedThread: options.stagedThread,
    materializedTurn: options.materializedTurn,
  };
};
