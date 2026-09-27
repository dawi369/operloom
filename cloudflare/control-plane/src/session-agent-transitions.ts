import { selectAgent } from "./authz-store";
import { resolveThreadAgentInstanceName } from "./chat-agent-connection-context";
import { getOwnedChatThread, promoteDraftChatThread } from "./chat-boundary-store";
import { appendControlPlaneEvent } from "./control-plane-events";
import { parseDataJson } from "./http";
import { toThreadLifecycleControlPlaneEvent } from "./session-lifecycle-events";
import type { WorkbenchSessionEvent } from "./session-event-types";
import { toJson, type AgentIdentity, type ChatThreadRow, type Env } from "./types";
import { stagedThreadTtlMs, titleFromInput, toThreadSummary } from "./session-agent-model";
import type {
  AgentHandoffSummary,
  CoordinatorRequest,
  SessionContext,
  SessionResponseOptions,
  SessionSnapshot,
  ThreadMutationStatus,
  ThreadStatusTransition,
} from "./session-agent-model";

export const ensureCoordinatorRequest = (value: unknown): CoordinatorRequest | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<CoordinatorRequest>;
  if (
    candidate.action !== "get" &&
    candidate.action !== "list" &&
    candidate.action !== "create" &&
    candidate.action !== "stageThread" &&
    candidate.action !== "materializeTurn" &&
    candidate.action !== "activate" &&
    candidate.action !== "update" &&
    candidate.action !== "switchAgent" &&
    candidate.action !== "stream" &&
    candidate.action !== "broadcast"
  ) {
    return null;
  }
  if (!candidate.identity?.scope?.userId || !candidate.identity.scope.workspaceId) return null;
  if (candidate.action !== "stream" && candidate.action !== "broadcast" && !candidate.agentHost) {
    return null;
  }
  return candidate as CoordinatorRequest;
};

export const encodeSse = (event: WorkbenchSessionEvent) =>
  `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

export const encodeHeartbeat = () => `: heartbeat ${new Date().toISOString()}\n\n`;

export const safeSnapshotData = (snapshot: SessionSnapshot) => ({
  revision: snapshot.revision,
  workspace: snapshot.workspace,
  activeAgent: snapshot.activeAgent,
  activeThread: snapshot.activeThread,
  threads: snapshot.threads,
  agentHandoff: snapshot.agentHandoff ?? null,
});

export const agentHandoffTransition = (startedAt: string) =>
  ({ type: "agent_handoff", startedAt }) satisfies SessionResponseOptions["transition"];

export const safeAgentSwitchData = (
  snapshot: SessionSnapshot,
  input: { startedAt: string; agentHandoff?: AgentHandoffSummary | null },
) => ({
  ...safeSnapshotData(snapshot),
  transition: agentHandoffTransition(input.startedAt),
  agentHandoff: input.agentHandoff ?? null,
});

export const safeThreadData = (
  snapshot: SessionSnapshot,
  thread: ReturnType<typeof toThreadSummary>,
) => ({
  ...safeSnapshotData(snapshot),
  thread,
});

export const transitionForStatus = (status: ThreadMutationStatus): ThreadStatusTransition => {
  if (status === "active") return "restore";
  if (status === "archived") return "archive";
  return "delete";
};

export const findFallbackActiveThread = async (
  env: Env,
  identity: AgentIdentity,
  excludeThreadId?: string,
) =>
  env.DB.prepare(
    `SELECT thread_id, session_id, user_id, workspace_id, agent_id, status, upstream_json,
            created_at, updated_at, last_seen_at
     FROM chat_threads
     WHERE user_id = ? AND workspace_id = ? AND status = 'active' AND thread_id != ?
     ORDER BY created_at DESC, thread_id DESC
     LIMIT 1`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, excludeThreadId ?? "")
    .first<ChatThreadRow>();

export const titleFromUpdate = titleFromInput;

export const appendThreadLifecycleEvent = (
  env: Env,
  identity: AgentIdentity,
  input: Parameters<typeof toThreadLifecycleControlPlaneEvent>[0],
) => appendControlPlaneEvent(env, identity, toThreadLifecycleControlPlaneEvent(input));

export const clearActiveThread = async (env: Env, identity: AgentIdentity, sessionId: string) => {
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE chat_sessions
     SET active_thread_id = NULL,
         last_seen_at = ?,
         updated_at = ?
     WHERE user_id = ? AND workspace_id = ? AND session_id = ?`,
  )
    .bind(timestamp, timestamp, identity.scope.userId, identity.scope.workspaceId, sessionId)
    .run();
};

export const updateChatSessionAgent = async (
  env: Env,
  identity: AgentIdentity,
  input: { sessionId: string; agentId: string; activeThreadId?: string | null },
) => {
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE chat_sessions
     SET agent_id = ?,
         active_thread_id = ?,
         last_seen_at = ?,
         updated_at = ?
     WHERE user_id = ? AND workspace_id = ? AND session_id = ?`,
  )
    .bind(
      input.agentId,
      input.activeThreadId ?? null,
      timestamp,
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      input.sessionId,
    )
    .run();
};

export const persistThreadMutation = async (
  env: Env,
  identity: AgentIdentity,
  thread: ChatThreadRow,
  input: { title?: string; status?: ThreadMutationStatus },
) => {
  const timestamp = new Date().toISOString();
  const upstream = parseDataJson(thread.upstream_json);
  if (input.title !== undefined) upstream.title = input.title;
  const status = input.status ?? thread.status;
  const revokesActiveResponse = status === "archived" || status === "deleted";
  const statements = [];

  if (revokesActiveResponse) {
    statements.push(
      env.DB.prepare(
        `UPDATE chat_intents
         SET status = 'cancelled', updated_at = ?
         WHERE user_id = ? AND workspace_id = ? AND thread_id = ?
           AND id IN (
             SELECT intent_id FROM chat_runs
             WHERE user_id = ? AND workspace_id = ? AND thread_id = ? AND status = 'running'
           )`,
      ).bind(
        timestamp,
        identity.scope.userId,
        identity.scope.workspaceId,
        thread.thread_id,
        identity.scope.userId,
        identity.scope.workspaceId,
        thread.thread_id,
      ),
      env.DB.prepare(
        `UPDATE chat_runs
         SET status = 'cancelled',
             metadata_json = json_set(metadata_json, '$.cancellationReason', ?, '$.cancelledAt', ?),
             error = NULL,
             updated_at = ?
         WHERE user_id = ? AND workspace_id = ? AND thread_id = ? AND status = 'running'`,
      ).bind(
        `thread_${status}`,
        timestamp,
        timestamp,
        identity.scope.userId,
        identity.scope.workspaceId,
        thread.thread_id,
      ),
    );
  }

  statements.push(
    env.DB.prepare(
      `UPDATE chat_threads
       SET status = ?, upstream_json = ?, updated_at = ?, last_seen_at = ?
       WHERE user_id = ? AND workspace_id = ? AND thread_id = ?`,
    ).bind(
      status,
      toJson(upstream),
      timestamp,
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      thread.thread_id,
    ),
  );
  const results = await env.DB.batch(statements);
  const runResult = revokesActiveResponse ? results[1] : undefined;
  return { cancelledRunningRuns: runResult?.meta?.changes ?? 0 };
};

export const abortThreadChatResponse = async (env: Env, thread: ChatThreadRow) => {
  const secret = env.OPERLOOM_AGENT_CONNECTION_SECRET?.trim();
  if (!env.ThreadChatAgent || !secret) return false;
  try {
    const instanceName = await resolveThreadAgentInstanceName(thread);
    const stub = env.ThreadChatAgent.get(env.ThreadChatAgent.idFromName(instanceName));
    const response = await stub.fetch("https://thread-agent.internal/internal/thread-cancel", {
      method: "POST",
      headers: { "x-operloom-agent-secret": secret },
    });
    return response.ok;
  } catch {
    return false;
  }
};

export const draftExpiryFromThread = (thread: ChatThreadRow) => {
  const upstream = parseDataJson(thread.upstream_json);
  const rawExpiresAt = typeof upstream.stageExpiresAt === "string" ? upstream.stageExpiresAt : "";
  const expiresAtMs = rawExpiresAt ? Date.parse(rawExpiresAt) : NaN;
  if (Number.isFinite(expiresAtMs)) return new Date(expiresAtMs).toISOString();

  const createdAtMs = Date.parse(thread.created_at);
  const fallbackMs = Number.isFinite(createdAtMs) ? createdAtMs : Date.now();
  return new Date(fallbackMs + stagedThreadTtlMs).toISOString();
};

export const isExpiredDraftThread = (thread: ChatThreadRow) =>
  thread.status === "draft" && Date.parse(draftExpiryFromThread(thread)) <= Date.now();

export const markThreadDeleted = async (
  env: Env,
  identity: AgentIdentity,
  thread: ChatThreadRow,
) => {
  const timestamp = new Date().toISOString();
  const upstream = {
    ...parseDataJson(thread.upstream_json),
    draft: false,
    abandonedAt: timestamp,
  };
  await env.DB.prepare(
    `UPDATE chat_threads
     SET status = 'deleted',
         upstream_json = ?,
         updated_at = ?,
         last_seen_at = ?
     WHERE user_id = ? AND workspace_id = ? AND thread_id = ? AND status = 'draft'`,
  )
    .bind(
      toJson(upstream),
      timestamp,
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      thread.thread_id,
    )
    .run();
};

export const reusableDraftThread = async (
  env: Env,
  identity: AgentIdentity,
  sessionId: string,
  activeThreadId?: string | null,
) => {
  if (!activeThreadId) return null;
  const thread = await getOwnedChatThread(env, identity.scope, activeThreadId);
  if (!thread || thread.session_id !== sessionId || thread.status !== "draft") return null;
  if (!isExpiredDraftThread(thread)) return thread;
  await markThreadDeleted(env, identity, thread);
  return null;
};

export const findReusableDraftThread = async (
  env: Env,
  identity: AgentIdentity,
  sessionId: string,
  ...threadIds: Array<string | null | undefined>
) => {
  for (const threadId of threadIds) {
    const reusable = await reusableDraftThread(env, identity, sessionId, threadId);
    if (reusable) return reusable;
  }
  return null;
};

export const materializeDraftThread = async (
  env: Env,
  identity: AgentIdentity,
  thread: ChatThreadRow,
  message: string,
) => {
  const activeAgent = await selectAgent(env, thread.agent_id, identity.scope.workspaceId);
  if (!activeAgent || activeAgent.status !== "active") {
    throw new Error("Agent is not active");
  }
  const promoted = await promoteDraftChatThread(env, identity.scope, thread.thread_id, {
    title: titleFromUpdate(message) ?? message,
  });
  if (!promoted.promoted || !promoted.thread || promoted.thread.status !== "active") {
    throw new Error("Staged chat could not be materialized");
  }
  return { activeAgent, thread: promoted.thread };
};

export const submitProgrammaticTurn = async (
  env: Env,
  input: { context: SessionContext; token: string; message: string; clientTurnId: string },
): Promise<
  { ok: true; status: number; messageId?: string } | { ok: false; status: number; error: string }
> => {
  if (!env.ThreadChatAgent) {
    return { ok: false, error: "ThreadChatAgent binding is not configured", status: 500 };
  }

  const stub = env.ThreadChatAgent.get(env.ThreadChatAgent.idFromName(input.context.instanceName));
  const response = await stub.fetch("https://thread-agent.internal/internal/programmatic-submit", {
    method: "POST",
    body: JSON.stringify({
      token: input.token,
      clientTurnId: input.clientTurnId,
      message: input.message,
      threadId: input.context.threadId,
      sessionId: input.context.sessionId,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    messageId?: unknown;
  };
  if (response.ok) {
    return {
      ok: true,
      status: response.status,
      messageId: typeof body.messageId === "string" ? body.messageId : undefined,
    };
  }
  return {
    ok: false,
    error: typeof body.error === "string" ? body.error : "Programmatic turn submit failed",
    status: response.status,
  };
};
