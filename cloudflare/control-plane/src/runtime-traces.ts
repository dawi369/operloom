import { json, parseDataJson } from "./http";
import {
  createId,
  toJson,
  type AgentIdentity,
  type Env,
  type RuntimeSpanRow,
  type RuntimeTraceRow,
  type TenantScope,
} from "./types";

export type RuntimeTraceKind =
  | "chat.thread.create"
  | "chat.run.stream"
  | "chat.agent.stream"
  | "tool.url.inspect"
  | "tool.repo.snapshot"
  | "tool.diagnostic.ping"
  | "tool.runner.echo"
  | "tool.artifact.metadata.test"
  | "tool.polymarket.market.search"
  | "tool.polymarket.market.snapshot"
  | "tool.polymarket.orderbook.snapshot"
  | "tool.swordfish.symbol.snapshot"
  | "tool.swordfish.bars.range"
  | "diagnostic.execution";

export type RuntimeTraceStatus = "running" | "completed" | "failed" | "blocked";

export type RuntimeSpanLayer =
  | "browser"
  | "vercel"
  | "cloudflare"
  | "durable_object"
  | "d1"
  | "provider"
  | "executor"
  | "tool";

export type RuntimeSpanStatus = "running" | "completed" | "failed" | "blocked";
export type RuntimeSpanType = "operation" | "phase" | "event";

export type RuntimeTraceContext = {
  traceId: string;
  kind: RuntimeTraceKind;
  rootName: string;
  startedAtMs: number;
};

export type IncomingRuntimeTrace = {
  traceId: string;
  authzStartedAtMs: number;
  authzEndedAtMs: number;
  authzSpans?: RuntimeTraceInputSpan[];
  vercelStartedAtMs?: number | null;
  vercelDurationMs?: number | null;
  threadOwnershipStartedAtMs?: number | null;
  threadOwnershipEndedAtMs?: number | null;
};

export type RuntimeTraceInputSpan = {
  name: string;
  layer: RuntimeSpanLayer;
  status?: RuntimeSpanStatus;
  startedAtMs: number;
  endedAtMs?: number;
  data?: Record<string, unknown>;
  spanType?: RuntimeSpanType;
  isAggregate?: boolean;
  bottleneckCandidate?: boolean;
};

const traceIdHeader = "x-operloom-trace-id";
const vercelStartedAtHeader = "x-operloom-vercel-started-at";
const vercelDurationHeader = "x-operloom-vercel-duration-ms";

export const runtimeTraceHeaders = {
  traceId: traceIdHeader,
  vercelStartedAt: vercelStartedAtHeader,
  vercelDurationMs: vercelDurationHeader,
};

const toIso = (valueMs: number) => new Date(valueMs).toISOString();

const duration = (startedAtMs: number, endedAtMs: number) =>
  Math.max(0, Math.round(endedAtMs - startedAtMs));

const readNumberHeader = (request: Request, name: string) => {
  const raw = request.headers.get(name);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

export const getTraceId = (request: Request) =>
  request.headers.get(traceIdHeader)?.trim() || createId("cf-trace");

export const readVercelTimingHeaders = (request: Request) => ({
  startedAtMs: readNumberHeader(request, vercelStartedAtHeader),
  durationMs: readNumberHeader(request, vercelDurationHeader),
});

const spanSemantics = (data: Record<string, unknown>) => {
  const spanType =
    data.spanType === "phase" || data.spanType === "event" || data.spanType === "operation"
      ? data.spanType
      : "operation";
  const isAggregate = typeof data.isAggregate === "boolean" ? data.isAggregate : false;
  const bottleneckCandidate =
    typeof data.bottleneckCandidate === "boolean"
      ? data.bottleneckCandidate
      : spanType === "operation" && !isAggregate;
  return { spanType, isAggregate, bottleneckCandidate };
};

const computeBottleneck = (spans: RuntimeSpanRow[]) => {
  let bottleneck: RuntimeSpanRow | null = null;
  const candidates = spans.filter((span) => {
    const data = parseDataJson(span.data_json);
    return spanSemantics(data).bottleneckCandidate;
  });

  for (const span of candidates) {
    if (typeof span.duration_ms !== "number") continue;
    if (!bottleneck || (bottleneck.duration_ms ?? 0) < span.duration_ms) bottleneck = span;
  }

  if (bottleneck) {
    return {
      spanId: bottleneck.span_id,
      confidence: "exact" as const,
      reason: "Longest operation span excluding phase summaries.",
    };
  }

  let fallbackBottleneck: RuntimeSpanRow | null = null;
  for (const span of spans) {
    if (typeof span.duration_ms !== "number" || span.duration_ms <= 0) continue;
    if (!fallbackBottleneck || (fallbackBottleneck.duration_ms ?? 0) < span.duration_ms) {
      fallbackBottleneck = span;
    }
  }
  return {
    spanId: fallbackBottleneck?.span_id ?? null,
    confidence: "fallback" as const,
    reason: fallbackBottleneck
      ? "No operation span candidates were available, so the longest non-zero span was used."
      : "No completed span durations were available.",
  };
};

const toTraceSummary = (row: RuntimeTraceRow) => ({
  traceId: row.trace_id,
  scope: {
    userId: row.user_id,
    workspaceId: row.workspace_id,
  },
  agentId: row.agent_id,
  kind: row.kind,
  status: row.status,
  rootName: row.root_name,
  summary: row.summary ?? undefined,
  bottleneckSpanId: row.bottleneck_span_id ?? undefined,
  bottleneckConfidence:
    parseDataJson(row.data_json).bottleneckConfidence === "fallback" ? "fallback" : "exact",
  bottleneckReason:
    typeof parseDataJson(row.data_json).bottleneckReason === "string"
      ? String(parseDataJson(row.data_json).bottleneckReason)
      : undefined,
  data: parseDataJson(row.data_json),
  startedAt: row.started_at,
  endedAt: row.ended_at ?? undefined,
  durationMs: row.duration_ms ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toSpanSummary = (row: RuntimeSpanRow, traceStartedAt?: string) => {
  const data = parseDataJson(row.data_json);
  const semantics = spanSemantics(data);
  const traceStartMs = traceStartedAt ? Date.parse(traceStartedAt) : Number.NaN;
  const spanStartMs = Date.parse(row.started_at);
  const offsetMs =
    Number.isFinite(traceStartMs) && Number.isFinite(spanStartMs)
      ? Math.max(0, Math.round(spanStartMs - traceStartMs))
      : undefined;
  return {
    spanId: row.span_id,
    traceId: row.trace_id,
    parentSpanId: row.parent_span_id ?? undefined,
    scope: {
      userId: row.user_id,
      workspaceId: row.workspace_id,
    },
    agentId: row.agent_id,
    name: row.name,
    layer: row.layer,
    status: row.status,
    spanType: semantics.spanType,
    isAggregate: semantics.isAggregate,
    bottleneckCandidate: semantics.bottleneckCandidate,
    offsetMs,
    data,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const readTraceRow = (env: Env, scope: TenantScope, traceId: string) =>
  env.DB.prepare(
    `SELECT trace_id, user_id, workspace_id, agent_id, kind, status, root_name, summary,
            bottleneck_span_id, data_json, started_at, ended_at, duration_ms, created_at,
            updated_at
     FROM runtime_traces
     WHERE user_id = ? AND workspace_id = ? AND trace_id = ?
     LIMIT 1`,
  )
    .bind(scope.userId, scope.workspaceId, traceId)
    .first<RuntimeTraceRow>();

export const listRuntimeTraceRows = async (env: Env, scope: TenantScope, limit = 10) => {
  const rows = await env.DB.prepare(
    `SELECT trace_id, user_id, workspace_id, agent_id, kind, status, root_name, summary,
            bottleneck_span_id, data_json, started_at, ended_at, duration_ms, created_at,
            updated_at
     FROM runtime_traces
     WHERE user_id = ? AND workspace_id = ?
     ORDER BY updated_at DESC, started_at DESC
     LIMIT ?`,
  )
    .bind(scope.userId, scope.workspaceId, limit)
    .all<RuntimeTraceRow>();
  return rows.results;
};

export const listRuntimeSpans = async (env: Env, scope: TenantScope, traceId: string) => {
  const rows = await env.DB.prepare(
    `SELECT span_id, trace_id, parent_span_id, user_id, workspace_id, agent_id, name, layer,
            status, data_json, started_at, ended_at, duration_ms, created_at, updated_at
     FROM runtime_spans
     WHERE user_id = ? AND workspace_id = ? AND trace_id = ?
     ORDER BY started_at ASC, created_at ASC`,
  )
    .bind(scope.userId, scope.workspaceId, traceId)
    .all<RuntimeSpanRow>();
  return rows.results;
};

export const getRuntimeTraceSnapshot = async (env: Env, scope: TenantScope, traceId: string) => {
  const trace = await readTraceRow(env, scope, traceId);
  if (!trace) return null;
  const spans = await listRuntimeSpans(env, scope, traceId);
  return {
    trace: toTraceSummary(trace),
    spans: spans.map((span) => toSpanSummary(span, trace.started_at)),
  };
};

export const getLatestRuntimeTraceSnapshot = async (env: Env, scope: TenantScope) => {
  const [latest] = await listRuntimeTraceRows(env, scope, 1);
  return latest ? getRuntimeTraceSnapshot(env, scope, latest.trace_id) : null;
};

export const listRuntimeTraceSummaries = async (env: Env, scope: TenantScope, limit = 10) => {
  const rows = await listRuntimeTraceRows(env, scope, limit);
  return rows.map(toTraceSummary);
};

export const startTrace = async (
  env: Env,
  identity: AgentIdentity,
  input: {
    traceId?: string;
    kind: RuntimeTraceKind;
    rootName: string;
    summary?: string;
    data?: Record<string, unknown>;
    startedAtMs?: number;
  },
): Promise<RuntimeTraceContext> => {
  const startedAtMs = input.startedAtMs ?? Date.now();
  const timestamp = toIso(startedAtMs);
  const traceId = input.traceId || createId("cf-trace");
  await env.DB.prepare(
    `INSERT INTO runtime_traces (
       trace_id, user_id, workspace_id, agent_id, kind, status, root_name, summary,
       data_json, started_at, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(trace_id) DO UPDATE SET
       updated_at = excluded.updated_at`,
  )
    .bind(
      traceId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      input.kind,
      "running",
      input.rootName,
      input.summary ?? null,
      toJson(input.data ?? {}),
      timestamp,
      timestamp,
      timestamp,
    )
    .run();
  return { traceId, kind: input.kind, rootName: input.rootName, startedAtMs };
};

export const recordSpan = async (
  env: Env,
  identity: AgentIdentity,
  input: {
    traceId: string;
    spanId?: string;
    parentSpanId?: string;
    name: string;
    layer: RuntimeSpanLayer;
    status?: RuntimeSpanStatus;
    data?: Record<string, unknown>;
    spanType?: RuntimeSpanType;
    isAggregate?: boolean;
    bottleneckCandidate?: boolean;
    startedAtMs: number;
    endedAtMs?: number;
  },
) => {
  const endedAtMs = input.endedAtMs ?? Date.now();
  const spanId = input.spanId ?? createId("cf-span");
  const timestamp = toIso(endedAtMs);
  await env.DB.prepare(
    `INSERT INTO runtime_spans (
       span_id, trace_id, parent_span_id, user_id, workspace_id, agent_id, name, layer, status,
       data_json, started_at, ended_at, duration_ms, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(span_id) DO UPDATE SET
       status = excluded.status,
       data_json = excluded.data_json,
       ended_at = excluded.ended_at,
       duration_ms = excluded.duration_ms,
       updated_at = excluded.updated_at`,
  )
    .bind(
      spanId,
      input.traceId,
      input.parentSpanId ?? null,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      input.name,
      input.layer,
      input.status ?? "completed",
      toJson({
        ...input.data,
        ...spanSemantics({
          spanType: input.spanType ?? input.data?.spanType,
          isAggregate: input.isAggregate ?? input.data?.isAggregate,
          bottleneckCandidate: input.bottleneckCandidate ?? input.data?.bottleneckCandidate,
        }),
      }),
      toIso(input.startedAtMs),
      toIso(endedAtMs),
      duration(input.startedAtMs, endedAtMs),
      timestamp,
      timestamp,
    )
    .run();
  return spanId;
};

export const recordIncomingRequestSpans = async (
  env: Env,
  identity: AgentIdentity,
  trace: RuntimeTraceContext,
  incoming?: IncomingRuntimeTrace,
) => {
  if (!incoming) return;

  if (incoming.vercelStartedAtMs !== null && incoming.vercelStartedAtMs !== undefined) {
    const vercelDurationMs = incoming.vercelDurationMs ?? 0;
    await recordSpan(env, identity, {
      traceId: trace.traceId,
      name: "Vercel handoff",
      layer: "vercel",
      startedAtMs: incoming.vercelStartedAtMs,
      endedAtMs: incoming.vercelStartedAtMs + vercelDurationMs,
      data: {
        source: "x-operloom-vercel-duration-ms",
        note: "Pre-forward Vercel proxy setup only; not full stream duration.",
      },
    });
  }

  await recordSpan(env, identity, {
    traceId: trace.traceId,
    name: "Cloudflare authz",
    layer: "cloudflare",
    startedAtMs: incoming.authzStartedAtMs,
    endedAtMs: incoming.authzEndedAtMs,
    spanType: "phase",
    isAggregate: true,
    bottleneckCandidate: false,
    data: { source: "resolveAgentIdentity" },
  });

  for (const span of incoming.authzSpans ?? []) {
    await recordSpan(env, identity, {
      traceId: trace.traceId,
      ...span,
    });
  }

  if (incoming.threadOwnershipStartedAtMs && incoming.threadOwnershipEndedAtMs) {
    await recordSpan(env, identity, {
      traceId: trace.traceId,
      name: "Thread ownership check",
      layer: "d1",
      startedAtMs: incoming.threadOwnershipStartedAtMs,
      endedAtMs: incoming.threadOwnershipEndedAtMs,
      data: { source: "getOwnedChatThread" },
    });
  }
};

export const finishTrace = async (
  env: Env,
  identity: AgentIdentity,
  trace: RuntimeTraceContext,
  input: {
    status: RuntimeTraceStatus;
    summary?: string;
    data?: Record<string, unknown>;
    endedAtMs?: number;
  },
) => {
  const endedAtMs = input.endedAtMs ?? Date.now();
  const spans = await listRuntimeSpans(env, identity.scope, trace.traceId);
  const bottleneck = computeBottleneck(spans);
  const data = {
    ...input.data,
    bottleneckConfidence: bottleneck.confidence,
    bottleneckReason: bottleneck.reason,
  };
  await env.DB.prepare(
    `UPDATE runtime_traces
     SET status = ?, summary = ?, bottleneck_span_id = ?, data_json = ?, ended_at = ?,
         duration_ms = ?, updated_at = ?
     WHERE user_id = ? AND workspace_id = ? AND trace_id = ?`,
  )
    .bind(
      input.status,
      input.summary ?? null,
      bottleneck.spanId,
      toJson(data),
      toIso(endedAtMs),
      duration(trace.startedAtMs, endedAtMs),
      toIso(endedAtMs),
      identity.scope.userId,
      identity.scope.workspaceId,
      trace.traceId,
    )
    .run();
};

export const handleLatestRuntimeTraces = async (env: Env, identity: AgentIdentity, url: URL) => {
  const requested = Number(url.searchParams.get("limit") ?? 10);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 25) : 10;
  const recentTraces = await listRuntimeTraceSummaries(env, identity.scope, limit);
  const latestTrace = recentTraces[0]
    ? await getRuntimeTraceSnapshot(env, identity.scope, recentTraces[0].traceId)
    : null;
  return json({
    ok: true,
    recentTraces,
    latestTrace: latestTrace?.trace ?? null,
    traceWaterfall: latestTrace?.spans ?? [],
  });
};

export const handleGetRuntimeTrace = async (env: Env, identity: AgentIdentity, traceId: string) => {
  const snapshot = await getRuntimeTraceSnapshot(env, identity.scope, traceId);
  if (!snapshot) return json({ ok: false, error: "Trace not found" }, { status: 404 });
  return json({ ok: true, trace: snapshot.trace, spans: snapshot.spans });
};
