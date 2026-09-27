import {
  durableAttemptGuard,
  requireDurableAttemptAuthority,
  type DurableAttemptAuthority,
} from "./durable-attempt-authority";
import type { RuntimeRecord } from "@operloom/agent-sdk";
import {
  publicBudgetContracts,
  type RuntimeBudgetLimits,
} from "../../../packages/workbench-client/src/public-budget-contracts";
import { sha256Hex } from "../../../lib/workbench/control-plane-signing";
import { runtimeStateCanonicalJson } from "./runtime-state";
import { json } from "./http";
import type { AgentIdentity, Env } from "./types";

const authority = `SELECT 1 FROM workspaces w
 JOIN memberships m ON m.workspace_id = w.id AND m.user_id = ? AND m.status = 'active'
 JOIN users u ON u.id = m.user_id AND u.status = 'active'
 WHERE w.id = ? AND w.status = 'active'`;
const actor = (identity: AgentIdentity) => [identity.scope.userId, identity.scope.workspaceId];
const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};
const hash = (value: unknown) => sha256Hex(runtimeStateCanonicalJson(value));
export const runtimeUsageCapabilitiesEnabled = (env: Env, capabilities: readonly string[]) =>
  (!capabilities.includes("models.structured.v2") ||
    (env.WORKBENCH_STRUCTURED_MODELS_ENABLED === "true" &&
      env.WORKBENCH_USAGE_LIMITS_ENABLED === "true")) &&
  (!capabilities.includes("usage.reservations.v2") ||
    env.WORKBENCH_USAGE_LIMITS_ENABLED === "true");
const table = (kind: "workflow" | "chat") => (kind === "workflow" ? "control_runs" : "chat_runs");
const metadata = (kind: "workflow" | "chat") =>
  kind === "workflow" ? "data_json" : "metadata_json";
const tokens = "COALESCE(input_tokens + output_tokens, reserved_tokens)";
const active = "status = 'reserved' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const selectTotals = `SELECT COALESCE(SUM(kind = 'model'),0) modelCalls, COALESCE(SUM(kind = 'tool'),0) toolCalls,
 COALESCE(SUM(CASE WHEN input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND usage_source = 'provider' THEN input_tokens + output_tokens ELSE 0 END),0) knownTokens,
 COALESCE(SUM(CASE WHEN input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND usage_source = 'fixture' THEN input_tokens + output_tokens ELSE 0 END),0) fixtureTokens,
 COALESCE(SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN reserved_tokens ELSE 0 END),0) estimatedTokens,
 COALESCE(SUM(${active}),0) activeOperations, COALESCE(SUM(status != 'settled'),0) unresolvedOperations
 FROM control_resource_reservations`;

export type RuntimeUsageReservation = {
  id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  run_id: string;
  run_kind: "workflow" | "chat";
  budget_run_id: string;
  budget_run_kind: "workflow" | "chat";
  request_hash: string;
  kind: "model" | "tool";
  estimated_input_tokens: number;
  reserved_tokens: number;
  input_tokens: number | null;
  output_tokens: number | null;
  status: "reserved" | "settled" | "unknown";
  usage_source: "provider" | "fixture" | "unreported";
  result_json: string | null;
  result_hash: string | null;
  error_code: string | null;
};
type UsageRun = { id: string; kind: "workflow" | "chat"; parent: string | null };

const resolveRun = async (
  env: Env,
  identity: AgentIdentity,
  id: string,
  kind: UsageRun["kind"],
): Promise<UsageRun> => {
  const meta = metadata(kind);
  const row =
    await env.DB.prepare(`SELECT id, COALESCE(json_extract(${meta}, '$.parentRunId'), json_extract(${meta}, '$.relation.parentRunId')) parent
    FROM ${table(kind)} WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ? AND status = 'running'
    AND COALESCE(json_extract(${meta}, '$.agentRevision'),0) = ?`)
      .bind(id, ...actor(identity), identity.agentId, identity.agentRevision ?? 0)
      .first<{ id: string; parent: string | null }>();
  if (!row)
    return fail("usage_run_inactive", "Resource admission requires an active canonical run");
  return { ...row, kind };
};
const requireAuthority = async (env: Env, identity: AgentIdentity, admin = false) => {
  const row = await env.DB.prepare(`${authority}${admin ? " AND m.role IN ('owner','admin')" : ""}`)
    .bind(...actor(identity))
    .first();
  if (!row) fail("usage_scope_denied", "Current workspace authority is required");
};
const readReservation = (env: Env, identity: AgentIdentity, id: string) =>
  env.DB.prepare(
    "SELECT * FROM control_resource_reservations WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?",
  )
    .bind(id, ...actor(identity), identity.agentId)
    .first<RuntimeUsageReservation>();

/** A new receipt is authority to dispatch once. Replays never grant dispatch authority. */
export const reserveRuntimeUsage = async (
  env: Env,
  identity: AgentIdentity,
  input: {
    runId: string;
    runKind: UsageRun["kind"];
    packId: string;
    kind: "model" | "tool";
    operationKey: string;
    payload: unknown;
    estimatedInputTokens?: number;
    maxOutputTokens?: number;
    contextSnapshotId?: string;
    maxRuntimeMs?: number;
    durableAttempt?: DurableAttemptAuthority;
  },
): Promise<{ fresh: boolean; reservation: RuntimeUsageReservation }> => {
  if (env.WORKBENCH_USAGE_LIMITS_ENABLED !== "true")
    return fail("runtime_capability_disabled", "Resource reservations are disabled");
  input = { ...input, durableAttempt: input.durableAttempt && { ...input.durableAttempt } };
  await requireAuthority(env, identity);
  await requireDurableAttemptAuthority(env, identity, input.runId, input.durableAttempt);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(input.operationKey))
    return fail("usage_key_invalid", "A bounded resource operation key is required");
  const estimated = input.kind === "model" ? (input.estimatedInputTokens ?? 0) : 0;
  const reserved = estimated + (input.kind === "model" ? (input.maxOutputTokens ?? 0) : 0);
  const maxRuntimeMs = input.maxRuntimeMs ?? 90000;
  if (!Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs < 1 || maxRuntimeMs > 3600000)
    return fail("usage_deadline_invalid", "Resource execution requires a bounded deadline");
  if (
    !Number.isSafeInteger(estimated) ||
    estimated < 0 ||
    !Number.isSafeInteger(reserved) ||
    reserved < 0 ||
    reserved > 1000000
  )
    return fail("usage_estimate_invalid", "Resource estimate exceeds supported bounds");
  const requestHash = await hash([
    input.packId,
    input.payload,
    estimated,
    reserved,
    maxRuntimeMs,
    input.contextSnapshotId ?? null,
    identity.agentRevision ?? 0,
    ...(input.durableAttempt ? [input.durableAttempt.stepId] : []),
  ]);
  const operationKey = input.durableAttempt
    ? `durable-${await hash([input.durableAttempt.stepId, input.operationKey])}`
    : input.operationKey;
  const id = `usage-${await hash([identity.scope.workspaceId, input.runKind, input.runId, input.kind, operationKey])}`;
  const replay = async (reservation: RuntimeUsageReservation) => {
    await requireDurableAttemptAuthority(
      env,
      identity,
      reservation.budget_run_id,
      input.durableAttempt,
    );
    if (reservation.request_hash !== requestHash)
      return fail("usage_key_conflict", "Resource key was already used with different content");
    return { fresh: false, reservation };
  };
  const prior = await readReservation(env, identity, id);
  if (prior) return replay(prior);
  const run = await resolveRun(env, identity, input.runId, input.runKind);
  let root = run;
  // Current delegation is bounded. Every parent must be a live canonical run in this same actor scope.
  const seen = new Set([root.id]);
  for (let depth = 0; root.parent; depth++) {
    if (depth >= 8 || seen.has(root.parent))
      return fail("usage_run_invalid", "Run ancestry exceeds supported bounds");
    seen.add(root.parent);
    const parent = await env.DB.prepare(
      "SELECT id FROM chat_runs WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?",
    )
      .bind(root.parent, ...actor(identity), identity.agentId)
      .first();
    root = await resolveRun(env, identity, root.parent, parent ? "chat" : "workflow");
  }
  const attemptGuard = durableAttemptGuard(identity, root.id, input.durableAttempt);
  const policy = await env.DB.prepare(
    "SELECT version FROM control_budget_policies WHERE workspace_id = ?",
  )
    .bind(identity.scope.workspaceId)
    .first<{ version: number }>();
  if (!policy)
    return fail(
      "budget_not_configured",
      "An administrator must configure workspace resource limits before execution",
    );
  const now = new Date().toISOString(),
    day = now.slice(0, 10);
  const scopeValues = [identity.scope.userId, identity.scope.workspaceId, identity.agentId];
  const live = (
    run: UsageRun,
  ) => `EXISTS (SELECT 1 FROM ${table(run.kind)} WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ? AND status = 'running'
    AND COALESCE(json_extract(${metadata(run.kind)}, '$.agentRevision'),0) = ?)`;
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO control_resource_reservations
        (id,user_id,workspace_id,agent_id,run_id,run_kind,budget_run_id,budget_run_kind,agent_revision,pack_id,operation_key,request_hash,kind,day,policy_version,
         estimated_input_tokens,reserved_tokens,status,created_at,expires_at,preconditions_met)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?, CASE WHEN
          ${attemptGuard.sql} AND EXISTS (${authority}) AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND workspace_id = ? AND status = 'active' AND runtime_revision = ?)
          AND ${live(run)} AND ${live(root)}
          AND NOT EXISTS (SELECT 1 FROM control_kill_switches WHERE user_id = ? AND workspace_id = ? AND enabled = 1
            AND ((scope_kind = 'workspace' AND scope_id = ?) OR (scope_kind = 'pack' AND scope_id = ?)))
          AND (? IS NULL OR EXISTS (SELECT 1 FROM control_context_snapshots WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?
            AND agent_revision = ? AND status = 'ready' AND run_id IN (?,?) AND NOT EXISTS (SELECT 1 FROM json_each(snapshot_json,'$.sources') s
              WHERE json_extract(s.value,'$.required') = 1 AND (json_extract(s.value,'$.status') != 'fresh' OR json_extract(s.value,'$.expiresAt') IS NULL
                OR json_extract(s.value,'$.expiresAt') <= strftime('%Y-%m-%dT%H:%M:%fZ','now')))))
          AND EXISTS (SELECT 1 FROM control_budget_policies p WHERE p.workspace_id = ? AND p.version = ?
            AND (SELECT COUNT(*) FROM control_resource_reservations WHERE workspace_id = p.workspace_id AND day = ? AND kind = 'model') + ? <= json_extract(p.limits_json,'$.dailyModelCalls')
            AND (SELECT COUNT(*) FROM control_resource_reservations WHERE workspace_id = p.workspace_id AND day = ? AND kind = 'tool') + ? <= json_extract(p.limits_json,'$.dailyToolCalls')
            AND (SELECT COALESCE(SUM(${tokens}),0) FROM control_resource_reservations WHERE workspace_id = p.workspace_id AND day = ?) + ? <= json_extract(p.limits_json,'$.dailyTokens')
            AND (SELECT COUNT(*) FROM control_resource_reservations WHERE workspace_id = p.workspace_id AND budget_run_kind = ? AND budget_run_id = ? AND kind = 'model') + ? <= json_extract(p.limits_json,'$.runModelCalls')
            AND (SELECT COUNT(*) FROM control_resource_reservations WHERE workspace_id = p.workspace_id AND budget_run_kind = ? AND budget_run_id = ? AND kind = 'tool') + ? <= json_extract(p.limits_json,'$.runToolCalls')
            AND (SELECT COALESCE(SUM(${tokens}),0) FROM control_resource_reservations WHERE workspace_id = p.workspace_id AND budget_run_kind = ? AND budget_run_id = ?) + ? <= json_extract(p.limits_json,'$.runTokens')
            AND (SELECT COUNT(*) FROM control_resource_reservations WHERE workspace_id = p.workspace_id AND ${active}) < json_extract(p.limits_json,'$.concurrentOperations'))
          THEN 1 ELSE 0 END`).bind(
        id,
        ...scopeValues,
        input.runId,
        input.runKind,
        root.id,
        root.kind,
        identity.agentRevision ?? 0,
        input.packId,
        operationKey,
        requestHash,
        input.kind,
        day,
        policy.version,
        estimated,
        reserved,
        now,
        new Date(Date.now() + maxRuntimeMs + 30000).toISOString(),
        ...attemptGuard.values,
        ...actor(identity),
        identity.agentId,
        identity.scope.workspaceId,
        identity.agentRevision ?? 0,
        run.id,
        ...scopeValues,
        identity.agentRevision ?? 0,
        root.id,
        ...scopeValues,
        identity.agentRevision ?? 0,
        ...actor(identity),
        identity.scope.workspaceId,
        input.packId,
        input.contextSnapshotId ?? null,
        input.contextSnapshotId ?? null,
        ...scopeValues,
        identity.agentRevision ?? 0,
        run.id,
        root.id,
        identity.scope.workspaceId,
        policy.version,
        day,
        Number(input.kind === "model"),
        day,
        Number(input.kind === "tool"),
        day,
        reserved,
        root.kind,
        root.id,
        Number(input.kind === "model"),
        root.kind,
        root.id,
        Number(input.kind === "tool"),
        root.kind,
        root.id,
        reserved,
      ),
      env.DB.prepare(`INSERT INTO control_plane_events (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
        VALUES (?,?,?,?,'usage.reserved','Resource usage reserved.','run',?,?,?)`).bind(
        id,
        ...scopeValues,
        input.runId,
        JSON.stringify({ reservationId: id, kind: input.kind, reservedTokens: reserved }),
        now,
      ),
    ]);
  } catch (error) {
    await requireAuthority(env, identity);
    await requireDurableAttemptAuthority(env, identity, root.id, input.durableAttempt);
    const concurrent = await readReservation(env, identity, id);
    if (concurrent) return replay(concurrent);
    if (String(error).includes("workspace_export_in_progress"))
      return fail(
        "workspace_export_in_progress",
        "Resource admission is fenced by a workspace export",
      );
    return fail(
      "resource_admission_denied",
      "Resource limits, execution authority or required evidence changed; no operation was dispatched",
    );
  }
  return { fresh: true, reservation: (await readReservation(env, identity, id))! };
};

/** Settlement records already-incurred usage even if membership/cancellation changed after dispatch. */
export const settleRuntimeUsage = async (
  env: Env,
  reservation: RuntimeUsageReservation,
  input: {
    status: "settled" | "unknown";
    inputTokens?: number;
    outputTokens?: number;
    source?: RuntimeUsageReservation["usage_source"];
    result?: RuntimeRecord;
    errorCode?: string;
  },
) => {
  for (const value of [input.inputTokens, input.outputTokens])
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 100000000))
      return fail("usage_invalid", "Provider usage is outside supported bounds");
  const result = input.result === undefined ? null : runtimeStateCanonicalJson(input.result);
  if (result && new TextEncoder().encode(result).length > 65536)
    return fail("model_output_limit", "Structured output exceeds 64 KiB");
  const resultHash = await hash([
    input.status,
    input.inputTokens ?? null,
    input.outputTokens ?? null,
    input.source ?? "unreported",
    result,
    input.errorCode ?? null,
  ]);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO control_plane_events (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
      SELECT ?,user_id,workspace_id,agent_id,'usage.settled','Resource usage outcome recorded.','run',run_id,?,?
      FROM control_resource_reservations WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ? AND request_hash = ? AND status = 'reserved'`).bind(
      `${reservation.id}:settled`,
      JSON.stringify({
        reservationId: reservation.id,
        kind: reservation.kind,
        status: input.status,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        usageSource: input.source ?? "unreported",
        errorCode: input.errorCode ?? null,
      }),
      now,
      reservation.id,
      reservation.user_id,
      reservation.workspace_id,
      reservation.agent_id,
      reservation.request_hash,
    ),
    env.DB.prepare(`UPDATE control_resource_reservations SET status = ?, input_tokens = ?, output_tokens = ?, usage_source = ?, result_json = ?, result_hash = ?, error_code = ?, settled_at = ?
      WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ? AND request_hash = ? AND status = 'reserved'`).bind(
      input.status,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.source ?? "unreported",
      result,
      resultHash,
      input.errorCode ?? null,
      now,
      reservation.id,
      reservation.user_id,
      reservation.workspace_id,
      reservation.agent_id,
      reservation.request_hash,
    ),
  ]);
  const row = await env.DB.prepare(
    "SELECT result_hash FROM control_resource_reservations WHERE id = ? AND workspace_id = ?",
  )
    .bind(reservation.id, reservation.workspace_id)
    .first<{ result_hash: string }>();
  if (!row || row.result_hash !== resultHash)
    return fail(
      "usage_settlement_conflict",
      "Resource settlement conflicts with an existing outcome",
    );
};

export const handleRuntimeBudgets = async (request: Request, env: Env, identity: AgentIdentity) => {
  if (env.WORKBENCH_USAGE_LIMITS_ENABLED !== "true")
    return json(
      { ok: false, code: "runtime_capability_disabled", error: "Resource budgets are disabled" },
      { status: 404 },
    );
  try {
    await requireAuthority(env, identity, true);
    if (new URL(request.url).pathname.endsWith("/workbench/usage")) {
      const parsed = publicBudgetContracts["GET /workbench/usage"].query.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!parsed.success)
        return json(
          {
            ok: false,
            code: "invalid_request",
            error: "Usage requires a UTC day and bounded pagination",
          },
          { status: 400 },
        );
      const { day, limit, cursor } = parsed.data;
      const rows =
        await env.DB.prepare(`SELECT id,user_id userId,agent_id agentId,run_id runId,run_kind runKind,budget_run_id budgetRunId,budget_run_kind budgetRunKind,
        kind,status,estimated_input_tokens estimatedInputTokens,reserved_tokens reservedTokens,input_tokens inputTokens,output_tokens outputTokens,usage_source usageSource,error_code errorCode,
        created_at createdAt,expires_at expiresAt,settled_at settledAt FROM control_resource_reservations WHERE workspace_id = ? AND day = ? AND (? IS NULL OR id > ?) ORDER BY id LIMIT ?`)
          .bind(identity.scope.workspaceId, day, cursor ?? null, cursor ?? null, limit + 1)
          .all<{ id: string }>();
      const reservations = rows.results ?? [];
      return json({
        ok: true,
        reservations: reservations.slice(0, limit),
        ...(reservations.length > limit ? { nextCursor: reservations[limit - 1]!.id } : {}),
      });
    }
    if (request.method === "GET") {
      const day = new Date().toISOString().slice(0, 10);
      const row = await env.DB.prepare(
        "SELECT version,limits_json FROM control_budget_policies WHERE workspace_id = ?",
      )
        .bind(identity.scope.workspaceId)
        .first<{ version: number; limits_json: string }>();
      const usage = await env.DB.prepare(`${selectTotals} WHERE workspace_id = ? AND day = ?`)
        .bind(identity.scope.workspaceId, day)
        .first();
      return json({
        ok: true,
        policy: row ? { version: row.version, limits: JSON.parse(row.limits_json) } : null,
        day,
        usage,
      });
    }
    const parsed = publicBudgetContracts["PUT /workbench/budgets"].request.safeParse(
      await request.json(),
    );
    if (!parsed.success)
      return json(
        { ok: false, code: "invalid_request", error: "Invalid budget configuration" },
        { status: 400 },
      );
    const input = parsed.data,
      requestHash = await hash(input);
    const id = `budget-${await hash([...actor(identity), input.idempotencyKey])}`;
    const read = () =>
      env.DB.prepare(
        "SELECT request_hash,version,limits_json FROM control_budget_changes WHERE id = ? AND workspace_id = ? AND user_id = ?",
      )
        .bind(id, identity.scope.workspaceId, identity.scope.userId)
        .first<{ request_hash: string; version: number; limits_json: string }>();
    const replay = (row: NonNullable<Awaited<ReturnType<typeof read>>>) => {
      if (row.request_hash !== requestHash)
        return fail("budget_key_conflict", "Budget key was reused with different content");
      return json({
        ok: true,
        policy: { version: row.version, limits: JSON.parse(row.limits_json) },
      });
    };
    const previous = await read();
    if (previous) return replay(previous);
    const now = new Date().toISOString(),
      limits = JSON.stringify(input.limits satisfies RuntimeBudgetLimits),
      version = input.expectedVersion + 1;
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO control_budget_changes (id,workspace_id,user_id,idempotency_key,request_hash,version,limits_json,created_at,preconditions_met)
          SELECT ?,?,?,?,?,?,?,?,CASE WHEN EXISTS (${authority} AND m.role IN ('owner','admin'))
          AND COALESCE((SELECT version FROM control_budget_policies WHERE workspace_id = ?),0) = ? THEN 1 ELSE 0 END`).bind(
          id,
          identity.scope.workspaceId,
          identity.scope.userId,
          input.idempotencyKey,
          requestHash,
          version,
          limits,
          now,
          ...actor(identity),
          identity.scope.workspaceId,
          input.expectedVersion,
        ),
        env.DB.prepare(`INSERT INTO control_budget_policies (workspace_id,version,limits_json,updated_by_user_id,updated_at) VALUES (?,?,?,?,?)
          ON CONFLICT(workspace_id) DO UPDATE SET version=excluded.version,limits_json=excluded.limits_json,updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at`).bind(
          identity.scope.workspaceId,
          version,
          limits,
          identity.scope.userId,
          now,
        ),
        env.DB.prepare(`INSERT INTO control_plane_events (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
          VALUES (?,?,?,?,'budget.updated','Workspace resource limits updated.','workspace',?,?,?)`).bind(
          id,
          ...actor(identity),
          identity.agentId,
          identity.scope.workspaceId,
          JSON.stringify({ version, limits: input.limits }),
          now,
        ),
      ]);
    } catch (error) {
      await requireAuthority(env, identity, true);
      const concurrent = await read();
      if (concurrent) return replay(concurrent);
      return fail(
        String(error).includes("workspace_export_in_progress")
          ? "workspace_export_in_progress"
          : "budget_version_conflict",
        "Budget update could not commit; fetch current configuration before retrying",
      );
    }
    return json({ ok: true, policy: { version, limits: input.limits } });
  } catch (error) {
    const candidate =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "budget_request_failed";
    const code = [
      "usage_scope_denied",
      "budget_key_conflict",
      "workspace_export_in_progress",
      "budget_version_conflict",
    ].includes(candidate)
      ? candidate
      : "budget_request_failed";
    return json(
      {
        ok: false,
        code,
        error:
          error instanceof Error && code !== "budget_request_failed"
            ? error.message
            : "Budget request failed",
      },
      { status: code === "usage_scope_denied" ? 403 : 409 },
    );
  }
};
