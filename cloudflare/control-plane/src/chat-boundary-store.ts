import { parseDataJson } from "./http";
import {
  createId,
  toJson,
  type AgentIdentity,
  type ChatIntentRow,
  type ChatPolicyDecisionRow,
  type ChatRunRow,
  type ChatSessionRow,
  type ChatThreadRow,
  type D1Result,
  type Env,
  type ExecutionMode,
  type TenantScope,
} from "./types";

type ChatRunStatus = "running" | "completed" | "failed";

const d1Duration = (result: D1Result) => {
  const durationMs = result.meta?.duration;
  return typeof durationMs === "number" && Number.isFinite(durationMs) ? durationMs : null;
};

export const createChatSession = async (
  env: Env,
  identity: AgentIdentity,
  metadata: Record<string, unknown> = {},
) => {
  const timestamp = new Date().toISOString();
  const sessionId = createId("cf-session");
  await env.DB.prepare(
    `INSERT INTO chat_sessions (
       session_id, user_id, workspace_id, agent_id, status, metadata_json,
       created_at, updated_at, last_seen_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      sessionId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      "active",
      toJson(metadata),
      timestamp,
      timestamp,
      timestamp,
    )
    .run();
  return sessionId;
};

export const getOwnedChatSession = async (env: Env, scope: TenantScope, sessionId: string) =>
  env.DB.prepare(
    `SELECT session_id, user_id, workspace_id, agent_id, status, active_thread_id,
            metadata_json, created_at, updated_at, last_seen_at
     FROM chat_sessions
     WHERE user_id = ? AND workspace_id = ? AND session_id = ?
     LIMIT 1`,
  )
    .bind(scope.userId, scope.workspaceId, sessionId)
    .first<ChatSessionRow>();

export const getLatestChatSession = async (env: Env, scope: TenantScope) =>
  env.DB.prepare(
    `SELECT session_id, user_id, workspace_id, agent_id, status, active_thread_id,
            metadata_json, created_at, updated_at, last_seen_at
     FROM chat_sessions
     WHERE user_id = ? AND workspace_id = ?
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
  )
    .bind(scope.userId, scope.workspaceId)
    .first<ChatSessionRow>();

export const getOrCreateLatestChatSession = async (env: Env, identity: AgentIdentity) => {
  const latest = await getLatestChatSession(env, identity.scope);
  return (
    latest?.session_id ??
    (await createChatSession(env, identity, { source: "cloudflare-chat-runtime" }))
  );
};

export const touchChatSession = async (
  env: Env,
  scope: TenantScope,
  sessionId: string,
  activeThreadId?: string,
) => {
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE chat_sessions
     SET active_thread_id = COALESCE(?, active_thread_id),
         last_seen_at = ?,
         updated_at = ?
     WHERE user_id = ? AND workspace_id = ? AND session_id = ?`,
  )
    .bind(activeThreadId ?? null, timestamp, timestamp, scope.userId, scope.workspaceId, sessionId)
    .run();
};

export const storeChatThread = async (
  env: Env,
  identity: AgentIdentity,
  sessionId: string,
  threadId: string,
  upstream: Record<string, unknown>,
) => {
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
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
  )
    .bind(
      threadId,
      sessionId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      "active",
      toJson(upstream),
      timestamp,
      timestamp,
      timestamp,
    )
    .run();
};

export const updateChatThreadUpstream = async (
  env: Env,
  scope: TenantScope,
  threadId: string,
  upstream: Record<string, unknown>,
) => {
  const timestamp = new Date().toISOString();
  let nextUpstream = upstream;
  const nextTitle = typeof upstream.title === "string" ? upstream.title.trim() : "";
  if (!nextTitle || nextTitle === "New chat") {
    const current = await getOwnedChatThread(env, scope, threadId);
    const currentUpstream = current ? parseDataJson(current.upstream_json) : {};
    const currentTitle =
      typeof currentUpstream.title === "string" ? currentUpstream.title.trim() : "";
    if (currentTitle && currentTitle !== "New chat") {
      nextUpstream = { ...upstream, title: currentTitle };
    }
  }
  await env.DB.prepare(
    `UPDATE chat_threads
     SET upstream_json = ?,
         updated_at = ?,
         last_seen_at = ?
     WHERE user_id = ? AND workspace_id = ? AND thread_id = ?`,
  )
    .bind(toJson(nextUpstream), timestamp, timestamp, scope.userId, scope.workspaceId, threadId)
    .run();
};

export const promoteDraftChatThread = async (
  env: Env,
  scope: TenantScope,
  threadId: string,
  upstreamPatch: Record<string, unknown>,
) => {
  const current = await getOwnedChatThread(env, scope, threadId);
  if (!current || current.status !== "draft") {
    return { promoted: false, thread: current };
  }

  const timestamp = new Date().toISOString();
  const currentUpstream = parseDataJson(current.upstream_json);
  const nextUpstream = {
    ...currentUpstream,
    ...upstreamPatch,
    draft: false,
    materializedAt: timestamp,
  };
  await env.DB.prepare(
    `UPDATE chat_threads
     SET status = 'active',
         upstream_json = ?,
         updated_at = ?,
         last_seen_at = ?
     WHERE user_id = ? AND workspace_id = ? AND thread_id = ? AND status = 'draft'`,
  )
    .bind(toJson(nextUpstream), timestamp, timestamp, scope.userId, scope.workspaceId, threadId)
    .run();

  return {
    promoted: true,
    thread: {
      ...current,
      status: "active",
      upstream_json: toJson(nextUpstream),
      updated_at: timestamp,
      last_seen_at: timestamp,
    },
  };
};

export const touchChatThread = async (env: Env, scope: TenantScope, threadId: string) => {
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE chat_threads
     SET last_seen_at = ?, updated_at = ?
     WHERE user_id = ? AND workspace_id = ? AND thread_id = ?`,
  )
    .bind(timestamp, timestamp, scope.userId, scope.workspaceId, threadId)
    .run();
};

export const getOwnedChatThread = async (env: Env, scope: TenantScope, threadId: string) =>
  env.DB.prepare(
    `SELECT thread_id, session_id, user_id, workspace_id, agent_id, status, upstream_json,
            created_at, updated_at, last_seen_at
     FROM chat_threads
     WHERE user_id = ? AND workspace_id = ? AND thread_id = ?
     LIMIT 1`,
  )
    .bind(scope.userId, scope.workspaceId, threadId)
    .first<ChatThreadRow>();

export const createChatIntent = async (
  env: Env,
  identity: AgentIdentity,
  input: {
    sessionId: string;
    threadId: string;
    executionMode: ExecutionMode;
    status: "allowed" | "blocked";
    payload: Record<string, unknown>;
  },
) => {
  const timestamp = new Date().toISOString();
  const intentId = createId("cf-chat-intent");
  await env.DB.prepare(
    `INSERT INTO chat_intents (
       id, session_id, thread_id, user_id, workspace_id, agent_id, type, execution_mode,
       status, payload_json, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      intentId,
      input.sessionId,
      input.threadId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      "chat.respond",
      input.executionMode,
      input.status,
      toJson(input.payload),
      timestamp,
      timestamp,
    )
    .run();
  return intentId;
};

export const createChatPolicyDecision = async (
  env: Env,
  identity: AgentIdentity,
  input: {
    intentId: string;
    threadId: string;
    decision: "allow" | "block";
    reason: string;
    executionMode: ExecutionMode;
    limits?: Record<string, unknown>;
  },
) => {
  const timestamp = new Date().toISOString();
  const decisionId = createId("cf-chat-policy");
  await env.DB.prepare(
    `INSERT INTO chat_policy_decisions (
       id, intent_id, thread_id, user_id, workspace_id, agent_id, decision, reason,
       execution_mode, limits_json, created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      decisionId,
      input.intentId,
      input.threadId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      input.decision,
      input.reason,
      input.executionMode,
      toJson(input.limits ?? {}),
      timestamp,
    )
    .run();
  return decisionId;
};

export const createAllowedChatRunBoundary = async (
  env: Env,
  identity: AgentIdentity,
  input: {
    sessionId: string;
    threadId: string;
    executionMode: ExecutionMode;
    payload: Record<string, unknown>;
    reason: string;
    limits?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
) => {
  const timestamp = new Date().toISOString();
  const intentId = createId("cf-chat-intent");
  const policyDecisionId = createId("cf-chat-policy");
  const runId = createId("cf-chat-run");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO chat_intents (
         id, session_id, thread_id, user_id, workspace_id, agent_id, type, execution_mode,
         status, payload_json, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      intentId,
      input.sessionId,
      input.threadId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      "chat.respond",
      input.executionMode,
      "allowed",
      toJson(input.payload),
      timestamp,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO chat_policy_decisions (
         id, intent_id, thread_id, user_id, workspace_id, agent_id, decision, reason,
         execution_mode, limits_json, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      policyDecisionId,
      intentId,
      input.threadId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      "allow",
      input.reason,
      input.executionMode,
      toJson(input.limits ?? {}),
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO chat_runs (
         id, intent_id, policy_decision_id, thread_id, user_id, workspace_id, agent_id,
         status, metadata_json, started_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      runId,
      intentId,
      policyDecisionId,
      input.threadId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      "running",
      toJson({ ...input.metadata, agentRevision: identity.agentRevision ?? 0 }),
      timestamp,
      timestamp,
    ),
  ]);
  return { intentId, policyDecisionId, runId };
};

export const isChatRunClaimConflict = (error: unknown) =>
  /UNIQUE constraint failed:\s*chat_runs\.user_id,\s*chat_runs\.workspace_id,\s*chat_runs\.thread_id/i.test(
    error instanceof Error ? error.message : String(error),
  );

export const createAgentChatRunStartMirror = async (
  env: Env,
  identity: AgentIdentity,
  input: {
    traceId: string;
    traceStartedAtMs: number;
    tokenVerifyStartedAtMs: number;
    tokenVerifyEndedAtMs: number;
    configResolveStartedAtMs: number;
    configResolveEndedAtMs: number;
    configCacheStatus: "hit" | "miss";
    sessionId: string;
    threadId: string;
    requestId?: string;
    commandId?: string;
    agentMetadata: unknown;
    model: string;
    runtimeConfig: unknown;
    behavior: unknown;
  },
) => {
  const timestamp = new Date().toISOString();
  const traceStartedAt = new Date(input.traceStartedAtMs).toISOString();
  const intentId = createId("cf-chat-intent");
  const policyDecisionId = createId("cf-chat-policy");
  const runId = createId("cf-chat-run");
  const tokenSpanId = createId("cf-span");
  const configSpanId = createId("cf-span");
  const batchStartedAtMs = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO runtime_traces (
         trace_id, user_id, workspace_id, agent_id, kind, status, root_name, summary,
         data_json, started_at, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(trace_id) DO UPDATE SET
         updated_at = excluded.updated_at`,
    ).bind(
      input.traceId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      "chat.agent.stream",
      "running",
      "Cloudflare Agent chat response",
      "Agent chat response started.",
      toJson({
        runtime: "cloudflare-agent-chat",
        threadId: input.threadId,
        sessionId: input.sessionId,
      }),
      traceStartedAt,
      traceStartedAt,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO runtime_spans (
         span_id, trace_id, parent_span_id, user_id, workspace_id, agent_id, name, layer, status,
         data_json, started_at, ended_at, duration_ms, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      tokenSpanId,
      input.traceId,
      null,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      "Agent token verify",
      "durable_object",
      "completed",
      toJson({
        spanType: "operation",
        isAggregate: false,
        bottleneckCandidate: true,
      }),
      new Date(input.tokenVerifyStartedAtMs).toISOString(),
      new Date(input.tokenVerifyEndedAtMs).toISOString(),
      Math.max(0, Math.round(input.tokenVerifyEndedAtMs - input.tokenVerifyStartedAtMs)),
      timestamp,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO runtime_spans (
         span_id, trace_id, parent_span_id, user_id, workspace_id, agent_id, name, layer, status,
         data_json, started_at, ended_at, duration_ms, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      configSpanId,
      input.traceId,
      null,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      input.configCacheStatus === "hit" ? "Config cache hit" : "Config cache miss",
      input.configCacheStatus === "hit" ? "durable_object" : "d1",
      "completed",
      toJson({
        cache: input.configCacheStatus,
        model: input.model,
        spanType: "operation",
        isAggregate: false,
        bottleneckCandidate: true,
      }),
      new Date(input.configResolveStartedAtMs).toISOString(),
      new Date(input.configResolveEndedAtMs).toISOString(),
      Math.max(0, Math.round(input.configResolveEndedAtMs - input.configResolveStartedAtMs)),
      timestamp,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO chat_intents (
         id, session_id, thread_id, user_id, workspace_id, agent_id, type, execution_mode,
         status, payload_json, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      intentId,
      input.sessionId,
      input.threadId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      "chat.respond",
      "ask",
      "allowed",
      toJson({
        source: "cloudflare-agent-chat",
        runtime: "cloudflare-agent-chat",
        requestId: input.requestId,
        agent: input.agentMetadata,
      }),
      timestamp,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO chat_policy_decisions (
         id, intent_id, thread_id, user_id, workspace_id, agent_id, decision, reason,
         execution_mode, limits_json, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      policyDecisionId,
      intentId,
      input.threadId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      "allow",
      "Agent chat v0 allows normal chat for active memberships.",
      "ask",
      toJson({
        runtime: "cloudflare-agent-chat",
        model: input.model,
      }),
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO chat_runs (
         id, intent_id, policy_decision_id, thread_id, user_id, workspace_id, agent_id,
         status, metadata_json,
         started_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      runId,
      intentId,
      policyDecisionId,
      input.threadId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      "running",
      toJson({
        source: "cloudflare-agent-chat",
        runtime: "cloudflare-agent-chat",
        traceId: input.traceId,
        modelProvider: "openrouter",
        model: input.model,
        runtimeConfig: input.runtimeConfig,
        behavior: input.behavior,
        commandId: input.commandId,
        agentRevision: identity.agentRevision ?? 0,
      }),
      timestamp,
      timestamp,
    ),
  ]);
  const batchEndedAtMs = Date.now();
  return {
    intentId,
    policyDecisionId,
    runId,
    batchStartedAtMs,
    batchEndedAtMs,
    d1DurationMs: results.reduce((sum, result) => sum + (d1Duration(result) ?? 0), 0),
  };
};

export const updateChatRun = async (
  env: Env,
  input: {
    runId: string;
    scope: TenantScope;
    status: ChatRunStatus;
    upstreamRunId?: string;
    metadata?: Record<string, unknown>;
    error?: string;
  },
) => {
  const timestamp = new Date().toISOString();
  const existing = await env.DB.prepare(
    `SELECT metadata_json
     FROM chat_runs
     WHERE user_id = ? AND workspace_id = ? AND id = ?
     LIMIT 1`,
  )
    .bind(input.scope.userId, input.scope.workspaceId, input.runId)
    .first<{ metadata_json: string }>();
  const existingMetadata = parseDataJson(existing?.metadata_json ?? "{}");
  const metadata = input.metadata ? { ...existingMetadata, ...input.metadata } : existingMetadata;

  const transitionGuard = input.status === "running" ? "" : " AND status = 'running'";
  const result = await env.DB.prepare(
    `UPDATE chat_runs
     SET status = ?,
         upstream_run_id = COALESCE(?, upstream_run_id),
         metadata_json = ?,
         error = ?,
         completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
         failed_at = CASE WHEN ? = 'failed' THEN ? ELSE failed_at END,
         updated_at = ?
     WHERE user_id = ? AND workspace_id = ? AND id = ?${transitionGuard}`,
  )
    .bind(
      input.status,
      input.upstreamRunId ?? null,
      toJson(metadata),
      input.error ?? null,
      input.status,
      timestamp,
      input.status,
      timestamp,
      timestamp,
      input.scope.userId,
      input.scope.workspaceId,
      input.runId,
    )
    .run();
  return { updated: (result as D1Result).meta?.changes !== 0 };
};

export const getLatestChatRun = async (env: Env, scope: TenantScope, threadId: string) =>
  env.DB.prepare(
    `SELECT id, intent_id, policy_decision_id, thread_id, user_id, workspace_id, agent_id,
            upstream_run_id, status, metadata_json, error, started_at, completed_at,
            failed_at, updated_at
     FROM chat_runs
     WHERE user_id = ? AND workspace_id = ? AND thread_id = ?
     ORDER BY updated_at DESC, started_at DESC
     LIMIT 1`,
  )
    .bind(scope.userId, scope.workspaceId, threadId)
    .first<ChatRunRow>();

export const getLatestRunningChatRun = async (env: Env, scope: TenantScope, threadId: string) =>
  env.DB.prepare(
    `SELECT id, intent_id, policy_decision_id, thread_id, user_id, workspace_id, agent_id,
            upstream_run_id, status, metadata_json, error, started_at, completed_at,
            failed_at, updated_at
     FROM chat_runs
     WHERE user_id = ? AND workspace_id = ? AND thread_id = ? AND status = 'running'
     ORDER BY updated_at DESC, started_at DESC
     LIMIT 1`,
  )
    .bind(scope.userId, scope.workspaceId, threadId)
    .first<ChatRunRow>();

export const getLatestChatIntent = async (env: Env, scope: TenantScope, threadId: string) =>
  env.DB.prepare(
    `SELECT id, session_id, thread_id, user_id, workspace_id, agent_id, type,
            execution_mode, status, payload_json, created_at, updated_at
     FROM chat_intents
     WHERE user_id = ? AND workspace_id = ? AND thread_id = ?
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
  )
    .bind(scope.userId, scope.workspaceId, threadId)
    .first<ChatIntentRow>();

export const getLatestChatPolicyDecision = async (env: Env, scope: TenantScope, threadId: string) =>
  env.DB.prepare(
    `SELECT id, intent_id, thread_id, user_id, workspace_id, agent_id, decision,
            reason, execution_mode, limits_json, created_at
     FROM chat_policy_decisions
     WHERE user_id = ? AND workspace_id = ? AND thread_id = ?
     ORDER BY created_at DESC
     LIMIT 1`,
  )
    .bind(scope.userId, scope.workspaceId, threadId)
    .first<ChatPolicyDecisionRow>();

export const toChatThreadSnapshot = (row: ChatThreadRow) => ({
  threadId: row.thread_id,
  sessionId: row.session_id,
  scope: {
    userId: row.user_id,
    workspaceId: row.workspace_id,
  },
  agentId: row.agent_id,
  status: row.status,
  upstream: parseDataJson(row.upstream_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastSeenAt: row.last_seen_at,
});

export const toChatRunSnapshot = (row: ChatRunRow | null) =>
  row
    ? {
        id: row.id,
        intentId: row.intent_id,
        policyDecisionId: row.policy_decision_id,
        threadId: row.thread_id,
        scope: {
          userId: row.user_id,
          workspaceId: row.workspace_id,
        },
        agentId: row.agent_id,
        upstreamRunId: row.upstream_run_id ?? undefined,
        status: row.status,
        metadata: parseDataJson(row.metadata_json),
        error: row.error ?? undefined,
        startedAt: row.started_at,
        completedAt: row.completed_at ?? undefined,
        failedAt: row.failed_at ?? undefined,
        updatedAt: row.updated_at,
      }
    : null;

export const toChatIntentSnapshot = (row: ChatIntentRow | null) =>
  row
    ? {
        id: row.id,
        sessionId: row.session_id,
        threadId: row.thread_id,
        scope: {
          userId: row.user_id,
          workspaceId: row.workspace_id,
        },
        agentId: row.agent_id,
        type: row.type,
        executionMode: row.execution_mode,
        status: row.status,
        payload: parseDataJson(row.payload_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

export const toChatPolicyDecisionSnapshot = (row: ChatPolicyDecisionRow | null) =>
  row
    ? {
        id: row.id,
        intentId: row.intent_id,
        threadId: row.thread_id,
        scope: {
          userId: row.user_id,
          workspaceId: row.workspace_id,
        },
        agentId: row.agent_id,
        decision: row.decision,
        reason: row.reason,
        executionMode: row.execution_mode,
        limits: parseDataJson(row.limits_json),
        createdAt: row.created_at,
      }
    : null;

export const toChatSessionSnapshot = (row: ChatSessionRow | null) =>
  row
    ? {
        sessionId: row.session_id,
        scope: {
          userId: row.user_id,
          workspaceId: row.workspace_id,
        },
        agentId: row.agent_id,
        status: row.status,
        activeThreadId: row.active_thread_id ?? undefined,
        metadata: parseDataJson(row.metadata_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastSeenAt: row.last_seen_at,
      }
    : null;
