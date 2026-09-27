import { loadLocalAgentPacks } from "../../../agent-packs";
import { agentManifestRegistry } from "../../../generated/agent-runtime/manifests";
import { sha256Hex } from "../../../lib/workbench/control-plane-signing";
import {
  buildPackWorkflowRequest,
  packWorkflowBindings,
  resolvePackRuntime,
  type PackWorkflowType,
} from "../../../lib/agent-runtime/registry";
import { resolveAgentBehaviorConfig } from "./agent-records";
import { runtimeStateCanonicalJson } from "./runtime-state";
import { selectAgent, selectMembership } from "./authz-store";
import { isRecord, json, parseDataJson, parseJson } from "./http";
import { requireActiveMembership, requireAdminMembership } from "./membership-policy";
import { nextCronOccurrence, nextMonitorOccurrence } from "./trigger-schedule";
import {
  executeTriggerDispatchByLease,
  processPendingTriggerDispatches,
} from "./trigger-execution";
import {
  createId,
  toJson,
  type AgentIdentity,
  type ControlTriggerDispatchRow,
  type ControlTriggerRow,
  type D1Result,
  type Env,
  type WorkerExecutionContext,
} from "./types";

const packs = loadLocalAgentPacks();
const identifierPattern = /^[a-z][a-z0-9._-]{0,79}$/;
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const maxRequestBytes = 16 * 1024;
const maxInputBytes = 8 * 1024;
const defaultLimit = 50;
const maximumLimit = 100;

const triggerColumns = `id, public_id, secret_hash, user_id, workspace_id, agent_id, pack_id, pack_trigger_id,
  kind, workflow_type, status, execution_json, config_json, input_json,
  max_concurrent_runs, version, next_trigger_at, last_triggered_at,
  created_by_user_id, created_at, updated_at`;
const dispatchColumns = `id, trigger_id, user_id, workspace_id, agent_id, idempotency_key,
  source, status, attempt_count, run_id, previous_run_id, scheduled_for, received_at,
  lease_owner, lease_expires_at, heartbeat_at, payload_json, error_json, created_at, updated_at`;

const changesOf = (result: D1Result | undefined) => result?.meta?.changes ?? 0;

const boundedRecord = (value: unknown, field: string) => {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > maxInputBytes) {
    throw new Error(`${field} is too large`);
  }
  return value;
};

const readBody = async (request: Request) => {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxRequestBytes) {
    return {
      ok: false as const,
      response: json({ ok: false, error: "Request body is too large" }, { status: 413 }),
    };
  }
  const parsed = parseJson(text);
  if (!isRecord(parsed)) {
    return {
      ok: false as const,
      response: json({ ok: false, error: "Body must be an object" }, { status: 400 }),
    };
  }
  return { ok: true as const, body: parsed };
};

const mapTrigger = (row: ControlTriggerRow) => ({
  id: row.id,
  publicId: row.public_id ?? undefined,
  agentId: row.agent_id,
  packId: row.pack_id,
  packTriggerId: row.pack_trigger_id,
  kind: row.kind,
  workflowType: row.workflow_type,
  status: row.status,
  execution: parseDataJson(row.execution_json),
  config: parseDataJson(row.config_json),
  input: parseDataJson(row.input_json),
  maxConcurrentRuns: row.max_concurrent_runs,
  version: row.version,
  nextTriggerAt: row.next_trigger_at ?? undefined,
  lastTriggeredAt: row.last_triggered_at ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const randomWebhookSecret = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const mapDispatch = (row: ControlTriggerDispatchRow) => ({
  id: row.id,
  triggerId: row.trigger_id,
  agentId: row.agent_id,
  idempotencyKey: row.idempotency_key,
  source: row.source,
  status: row.status,
  attemptCount: row.attempt_count,
  runId: row.run_id ?? undefined,
  previousRunId: row.previous_run_id ?? undefined,
  scheduledFor: row.scheduled_for ?? undefined,
  receivedAt: row.received_at,
  payload: parseDataJson(row.payload_json),
  error: parseDataJson(row.error_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const requireMembership = async (env: Env, identity: AgentIdentity, admin: boolean) => {
  const membership = await selectMembership(env, identity.scope.userId, identity.scope.workspaceId);
  return admin ? requireAdminMembership(membership) : requireActiveMembership(membership);
};

export const findTrigger = (env: Env, identity: AgentIdentity, triggerId: string) =>
  env.DB.prepare(
    `SELECT ${triggerColumns} FROM control_triggers
     WHERE user_id = ? AND workspace_id = ? AND agent_id = ? AND id = ? LIMIT 1`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, identity.agentId, triggerId)
    .first<ControlTriggerRow>();

export const resolveCheckedInTrigger = async (
  env: Env,
  identity: AgentIdentity,
  packId: string,
  packTriggerId: string,
) => {
  const agent = await selectAgent(env, identity.agentId, identity.scope.workspaceId);
  if (!agent || agent.status !== "active") return null;
  const behavior = resolveAgentBehaviorConfig(agent);
  const conformance =
    env.WORKBENCH_E2E_MODE === "true" || env.WORKBENCH_CONFORMANCE_MODE === "true";
  const pack =
    packs.find((candidate) => candidate.id === packId) ??
    (conformance
      ? agentManifestRegistry[packId as keyof typeof agentManifestRegistry]?.module
      : undefined);
  if (!pack || behavior.pack?.id !== pack.id || behavior.pack.version !== pack.version) return null;
  const trigger = pack.triggers.find((candidate) => candidate.id === packTriggerId);
  if (!trigger) return null;
  const workflow = pack.workflows.find((candidate) => candidate.type === trigger.workflowType);
  const snapshotTrigger = behavior.pack.triggers.find(
    (candidate) =>
      candidate.id === packTriggerId && candidate.workflowType === trigger.workflowType,
  );
  const snapshotWorkflow = behavior.pack.workflows.find(
    (candidate) => candidate.type === trigger.workflowType,
  );
  const binding = packWorkflowBindings[trigger.workflowType as PackWorkflowType];
  if (
    !workflow ||
    !snapshotTrigger ||
    !snapshotWorkflow ||
    !binding ||
    binding.requiredPackId !== pack.id ||
    binding.engine !== workflow.engine ||
    binding.engine !== snapshotWorkflow.engine
  )
    return null;
  const config =
    trigger.kind === "schedule"
      ? { cron: trigger.cron, timezone: trigger.timezone }
      : trigger.kind === "monitor"
        ? { intervalSeconds: trigger.intervalSeconds }
        : { eventType: trigger.eventType };
  return { pack, trigger, binding, config };
};

const normalizeWorkflowInput = (
  workflowType: string,
  raw: unknown,
): Record<string, string | number | boolean> => {
  const input = raw === undefined ? {} : boundedRecord(raw, "input");
  const request = buildPackWorkflowRequest(workflowType, input);
  if (!request || request.executionMode !== "dry_run")
    throw new Error("Trigger workflow is not runnable");
  boundedRecord(request.input, "normalized input");
  return request.input;
};

const initialNextTriggerAt = (
  declared: Awaited<ReturnType<typeof resolveCheckedInTrigger>>,
  now: Date,
) => {
  if (!declared || declared.trigger.kind === "webhook") return null;
  return (
    declared.trigger.kind === "schedule"
      ? nextCronOccurrence({
          cron: declared.trigger.cron,
          timezone: declared.trigger.timezone,
          after: now,
        })
      : nextMonitorOccurrence({
          intervalSeconds: declared.trigger.intervalSeconds,
          after: now,
        })
  ).toISOString();
};

export const handleListTriggers = async (env: Env, identity: AgentIdentity, url: URL) => {
  const membershipError = await requireMembership(env, identity, false);
  if (membershipError) return membershipError;
  const requested = Number(url.searchParams.get("limit") ?? defaultLimit);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), maximumLimit)
    : defaultLimit;
  const rows = await env.DB.prepare(
    `SELECT ${triggerColumns} FROM control_triggers
     WHERE user_id = ? AND workspace_id = ? AND agent_id = ?
     ORDER BY updated_at DESC, created_at DESC LIMIT ?`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, identity.agentId, limit)
    .all<ControlTriggerRow>();
  return json({ ok: true, triggers: rows.results.map(mapTrigger), limit });
};

export const handleGetTrigger = async (env: Env, identity: AgentIdentity, triggerId: string) => {
  const membershipError = await requireMembership(env, identity, false);
  if (membershipError) return membershipError;
  const trigger = await findTrigger(env, identity, triggerId);
  return trigger
    ? json({ ok: true, trigger: mapTrigger(trigger) })
    : json({ ok: false, error: "Trigger not found" }, { status: 404 });
};

export const handleCreateTrigger = async (request: Request, env: Env, identity: AgentIdentity) => {
  const membershipError = await requireMembership(env, identity, true);
  if (membershipError) return membershipError;
  const parsed = await readBody(request);
  if (!parsed.ok) return parsed.response;
  const packId = typeof parsed.body.packId === "string" ? parsed.body.packId.trim() : "";
  const packTriggerId =
    typeof parsed.body.packTriggerId === "string" ? parsed.body.packTriggerId.trim() : "";
  if (!identifierPattern.test(packId) || !identifierPattern.test(packTriggerId)) {
    return json({ ok: false, error: "packId and packTriggerId are invalid" }, { status: 400 });
  }
  const declared = await resolveCheckedInTrigger(env, identity, packId, packTriggerId);
  if (!declared)
    return json({ ok: false, error: "Active pack trigger not found" }, { status: 404 });
  const execution = parsed.body.execution ?? "request";
  if (execution !== "request" && execution !== "durable")
    return json({ ok: false, error: "Execution must be request or durable" }, { status: 400 });
  if (execution === "durable") {
    const runtime = resolvePackRuntime(declared.pack.id, declared.pack.version);
    if (
      env.WORKBENCH_DURABLE_WORKFLOWS_ENABLED !== "true" ||
      !env.DURABLE_WORKFLOWS ||
      !runtime.runnable ||
      runtime.controlPlane.apiVersion !== 2 ||
      !runtime.controlPlane.workflows.find(
        (workflow) => workflow.type === declared.trigger.workflowType,
      )?.durable
    )
      return json(
        {
          ok: false,
          error: "Durable workflow is unavailable",
          code: "runtime_capability_disabled",
        },
        { status: 503 },
      );
  }
  const requestedStatus = parsed.body.status ?? "paused";
  if (requestedStatus !== "paused" && requestedStatus !== "enabled") {
    return json({ ok: false, error: "New triggers must be paused or enabled" }, { status: 400 });
  }
  let input: Record<string, string | number | boolean>;
  try {
    input = normalizeWorkflowInput(declared.trigger.workflowType, parsed.body.input);
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : "Invalid input" },
      { status: 400 },
    );
  }

  const id = createId("cf-trigger");
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const nextTriggerAt = initialNextTriggerAt(declared, nowDate);
  const publicId = declared.trigger.kind === "webhook" ? createId("hook") : null;
  const webhookSecret = declared.trigger.kind === "webhook" ? randomWebhookSecret() : null;
  const secretHash = webhookSecret ? await sha256Hex(webhookSecret) : null;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO control_triggers (
        id, public_id, secret_hash, user_id, workspace_id, agent_id, pack_id, pack_trigger_id, kind,
        workflow_type, status, execution_json, config_json, input_json,
        max_concurrent_runs, version, next_trigger_at, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    ).bind(
      id,
      publicId,
      secretHash,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      declared.pack.id,
      declared.trigger.id,
      declared.trigger.kind,
      declared.trigger.workflowType,
      requestedStatus,
      toJson({
        mode: "dry_run",
        policy: "trigger-readonly-v0",
        ...(execution === "durable" ? { runtime: "durable" } : {}),
      }),
      toJson(declared.config),
      toJson(input),
      declared.pack.resourceLimits.maxConcurrentRuns,
      nextTriggerAt,
      identity.scope.userId,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO control_audit_events (
        id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
      ) SELECT ?, ?, ?, 'trigger.created', ?, 'trigger', ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM control_triggers WHERE id = ? AND created_at = ?)`,
    ).bind(
      createId("cf-audit"),
      identity.scope.userId,
      identity.scope.workspaceId,
      `Created ${declared.trigger.id} trigger.`,
      id,
      toJson({ packId, packTriggerId, workflowType: declared.trigger.workflowType }),
      now,
      id,
      now,
    ),
  ]);
  if (changesOf(results[0]) === 0) {
    const existing = await env.DB.prepare(
      `SELECT ${triggerColumns} FROM control_triggers
       WHERE user_id = ? AND workspace_id = ? AND agent_id = ? AND pack_id = ? AND pack_trigger_id = ? LIMIT 1`,
    )
      .bind(
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        packId,
        packTriggerId,
      )
      .first<ControlTriggerRow>();
    if (existing && (parseDataJson(existing.execution_json).runtime ?? "request") !== execution)
      return json(
        {
          ok: false,
          error: "Existing trigger uses a different execution mode",
          code: "trigger_execution_conflict",
        },
        { status: 409 },
      );
    return json({ ok: true, created: false, trigger: existing ? mapTrigger(existing) : undefined });
  }
  const created = await findTrigger(env, identity, id);
  return json(
    {
      ok: true,
      created: true,
      trigger: created ? mapTrigger(created) : undefined,
      ...(webhookSecret ? { webhookSecret } : {}),
    },
    { status: 201 },
  );
};

export const handleUpdateTrigger = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
  triggerId: string,
) => {
  const membershipError = await requireMembership(env, identity, true);
  if (membershipError) return membershipError;
  const current = await findTrigger(env, identity, triggerId);
  if (!current) return json({ ok: false, error: "Trigger not found" }, { status: 404 });
  if (current.status === "disabled")
    return json({ ok: false, error: "Disabled triggers are terminal" }, { status: 409 });
  const parsed = await readBody(request);
  if (!parsed.ok) return parsed.response;
  const expectedVersion = parsed.body.expectedVersion;
  if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 1) {
    return json({ ok: false, error: "expectedVersion is required" }, { status: 400 });
  }
  const status = parsed.body.status ?? current.status;
  if (!(["enabled", "paused", "disabled"] as unknown[]).includes(status)) {
    return json({ ok: false, error: "Trigger status is invalid" }, { status: 400 });
  }
  const declared = await resolveCheckedInTrigger(
    env,
    identity,
    current.pack_id,
    current.pack_trigger_id,
  );
  if (!declared)
    return json({ ok: false, error: "Active pack trigger not found" }, { status: 409 });
  let input = parseDataJson(current.input_json) as Record<string, string | number | boolean>;
  if (parsed.body.input !== undefined) {
    try {
      input = normalizeWorkflowInput(current.workflow_type, parsed.body.input);
    } catch (error) {
      return json(
        { ok: false, error: error instanceof Error ? error.message : "Invalid input" },
        { status: 400 },
      );
    }
  }
  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare(
      `UPDATE control_triggers SET status = ?, input_json = ?, version = version + 1, updated_at = ?
       WHERE user_id = ? AND workspace_id = ? AND agent_id = ? AND id = ?
         AND status != 'disabled' AND version = ?`,
    ).bind(
      status,
      toJson(input),
      now,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      triggerId,
      expectedVersion,
    ),
  ];
  if (status === "disabled") {
    statements.push(
      env.DB.prepare(
        `UPDATE control_runs
         SET status = 'cancelled', cancelled_at = ?, last_event_at = ?,
             data_json = json_set(data_json, '$.summary', 'Cancelled because the trigger was disabled.'),
             updated_at = ?
         WHERE user_id = ? AND workspace_id = ? AND agent_id = ?
           AND status IN ('queued', 'running', 'waiting', 'interrupted')
           AND id IN (
             SELECT run_id FROM control_trigger_dispatches
             WHERE trigger_id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?
               AND run_id IS NOT NULL AND status IN ('leased', 'running')
           )
           AND EXISTS (
             SELECT 1 FROM control_triggers
             WHERE id = ? AND status = 'disabled' AND updated_at = ?
           )`,
      ).bind(
        now,
        now,
        now,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        triggerId,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        triggerId,
        now,
      ),
      env.DB.prepare(
        `UPDATE control_workflow_intents
         SET status = 'cancelled', updated_at = ?
         WHERE user_id = ? AND workspace_id = ? AND agent_id = ?
           AND status IN ('queued', 'running', 'waiting', 'interrupted')
           AND id IN (
             SELECT workflow_intent_id FROM control_runs
             WHERE user_id = ? AND workspace_id = ? AND agent_id = ?
               AND status = 'cancelled' AND updated_at = ?
           )`,
      ).bind(
        now,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        now,
      ),
      env.DB.prepare(
        `UPDATE control_trigger_dispatches
         SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
             error_json = ?, updated_at = ?
         WHERE trigger_id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?
           AND status IN ('pending', 'leased', 'running')
           AND EXISTS (
             SELECT 1 FROM control_triggers
             WHERE id = ? AND status = 'disabled' AND updated_at = ?
           )`,
      ).bind(
        toJson({ code: "trigger_disabled", message: "Trigger was disabled." }),
        now,
        triggerId,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        triggerId,
        now,
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO control_audit_events (
        id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
      ) SELECT ?, ?, ?, 'trigger.updated', ?, 'trigger', ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM control_triggers WHERE id = ? AND version = ?)`,
    ).bind(
      createId("cf-audit"),
      identity.scope.userId,
      identity.scope.workspaceId,
      `Updated ${current.pack_trigger_id} trigger.`,
      triggerId,
      toJson({ status }),
      now,
      triggerId,
      (expectedVersion as number) + 1,
    ),
  );
  const results = await env.DB.batch(statements);
  if (changesOf(results[0]) === 0)
    return json({ ok: false, error: "Trigger version conflict" }, { status: 409 });
  const updated = await findTrigger(env, identity, triggerId);
  return json({ ok: true, trigger: updated ? mapTrigger(updated) : undefined });
};

export const handleListTriggerDispatches = async (env: Env, identity: AgentIdentity, url: URL) => {
  const membershipError = await requireMembership(env, identity, false);
  if (membershipError) return membershipError;
  const triggerId = url.searchParams.get("triggerId")?.trim();
  if (triggerId && triggerId.length > 160)
    return json({ ok: false, error: "triggerId is invalid" }, { status: 400 });
  const requested = Number(url.searchParams.get("limit") ?? defaultLimit);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), maximumLimit)
    : defaultLimit;
  const rows = triggerId
    ? await env.DB.prepare(
        `SELECT ${dispatchColumns} FROM control_trigger_dispatches WHERE user_id = ? AND workspace_id = ? AND agent_id = ? AND trigger_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
        .bind(identity.scope.userId, identity.scope.workspaceId, identity.agentId, triggerId, limit)
        .all<ControlTriggerDispatchRow>()
    : await env.DB.prepare(
        `SELECT ${dispatchColumns} FROM control_trigger_dispatches WHERE user_id = ? AND workspace_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
        .bind(identity.scope.userId, identity.scope.workspaceId, identity.agentId, limit)
        .all<ControlTriggerDispatchRow>();
  return json({ ok: true, dispatches: rows.results.map(mapDispatch), limit });
};

export const handleGetTriggerDispatch = async (
  env: Env,
  identity: AgentIdentity,
  dispatchId: string,
) => {
  const membershipError = await requireMembership(env, identity, false);
  if (membershipError) return membershipError;
  const row = await env.DB.prepare(
    `SELECT ${dispatchColumns} FROM control_trigger_dispatches WHERE user_id = ? AND workspace_id = ? AND agent_id = ? AND id = ? LIMIT 1`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, identity.agentId, dispatchId)
    .first<ControlTriggerDispatchRow>();
  return row
    ? json({ ok: true, dispatch: mapDispatch(row) })
    : json({ ok: false, error: "Trigger dispatch not found" }, { status: 404 });
};

export const handleCreateTriggerDispatch = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
  triggerId: string,
  ctx?: WorkerExecutionContext,
) => {
  const membershipError = await requireMembership(env, identity, true);
  if (membershipError) return membershipError;
  const trigger = await findTrigger(env, identity, triggerId);
  if (!trigger) return json({ ok: false, error: "Trigger not found" }, { status: 404 });
  if (trigger.status !== "enabled")
    return json({ ok: false, error: "Trigger is not enabled" }, { status: 409 });
  if (!(await resolveCheckedInTrigger(env, identity, trigger.pack_id, trigger.pack_trigger_id))) {
    return json({ ok: false, error: "Active pack trigger not found" }, { status: 409 });
  }
  const parsed = await readBody(request);
  if (!parsed.ok) return parsed.response;
  const idempotencyKey =
    typeof parsed.body.idempotencyKey === "string" ? parsed.body.idempotencyKey.trim() : "";
  if (!idempotencyKeyPattern.test(idempotencyKey))
    return json({ ok: false, error: "idempotencyKey is invalid" }, { status: 400 });
  let payload: Record<string, unknown> = {};
  try {
    payload =
      parsed.body.payload === undefined ? {} : boundedRecord(parsed.body.payload, "payload");
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : "Invalid payload" },
      { status: 400 },
    );
  }
  const scheduledFor =
    typeof parsed.body.scheduledFor === "string" ? parsed.body.scheduledFor.trim() : undefined;
  if (scheduledFor && (scheduledFor.length > 80 || Number.isNaN(Date.parse(scheduledFor)))) {
    return json({ ok: false, error: "scheduledFor is invalid" }, { status: 400 });
  }
  const id = createId("cf-dispatch");
  const now = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO control_trigger_dispatches (
        id, trigger_id, user_id, workspace_id, agent_id, idempotency_key, source,
        status, attempt_count, scheduled_for, received_at, payload_json, error_json,
        created_at, updated_at
      ) SELECT ?, ?, ?, ?, ?, ?, 'manual', 'pending', 0, ?, ?, ?, '{}', ?, ?
        WHERE EXISTS (
          SELECT 1 FROM control_triggers
          WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ? AND status = 'enabled'
            AND (json_extract(execution_json,'$.runtime') IS NOT 'durable' OR
              (SELECT COUNT(*) FROM control_trigger_dispatches d WHERE d.trigger_id=control_triggers.id AND d.status='pending') < 100)
        )`,
    ).bind(
      id,
      triggerId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      idempotencyKey,
      scheduledFor ?? null,
      now,
      toJson(payload),
      now,
      now,
      triggerId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
    ),
    env.DB.prepare(
      `INSERT INTO control_audit_events (
        id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
      ) SELECT ?, ?, ?, 'trigger.dispatch.received', ?, 'triggerDispatch', ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM control_trigger_dispatches WHERE id = ? AND created_at = ?)`,
    ).bind(
      createId("cf-audit"),
      identity.scope.userId,
      identity.scope.workspaceId,
      `Received manual dispatch for ${trigger.pack_trigger_id}.`,
      id,
      toJson({ triggerId, idempotencyKey }),
      now,
      id,
      now,
    ),
  ]);
  const created = changesOf(results[0]) > 0;
  const dispatch = await env.DB.prepare(
    `SELECT ${dispatchColumns} FROM control_trigger_dispatches
     WHERE user_id = ? AND workspace_id = ? AND agent_id = ? AND trigger_id = ? AND idempotency_key = ? LIMIT 1`,
  )
    .bind(
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      triggerId,
      idempotencyKey,
    )
    .first<ControlTriggerDispatchRow>();
  if (!dispatch)
    return json({ ok: false, error: "Trigger dispatch was not accepted" }, { status: 409 });
  if (
    parseDataJson(trigger.execution_json).runtime === "durable" &&
    (runtimeStateCanonicalJson(parseDataJson(dispatch.payload_json)) !==
      runtimeStateCanonicalJson(payload) ||
      dispatch.scheduled_for !== (scheduledFor ?? null))
  )
    return json(
      {
        ok: false,
        error: "Dispatch key already identifies different content",
        code: "trigger_dispatch_conflict",
      },
      { status: 409 },
    );
  if (created && ctx) {
    const leaseOwner = `manual:${identity.scope.userId}:${crypto.randomUUID()}`;
    ctx.waitUntil(
      processPendingTriggerDispatches(env, {
        leaseOwner,
        dispatchId: dispatch.id,
        limit: 1,
      }),
    );
  }
  return json(
    { ok: true, created, duplicate: !created, dispatch: mapDispatch(dispatch) },
    { status: created ? 201 : 200 },
  );
};

export const handleReplayTriggerDispatch = async (
  env: Env,
  identity: AgentIdentity,
  dispatchId: string,
  ctx?: WorkerExecutionContext,
) => {
  const membershipError = await requireMembership(env, identity, true);
  if (membershipError) return membershipError;
  const dispatch = await env.DB.prepare(
    `SELECT ${dispatchColumns} FROM control_trigger_dispatches
     WHERE user_id = ? AND workspace_id = ? AND agent_id = ? AND id = ? LIMIT 1`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, identity.agentId, dispatchId)
    .first<ControlTriggerDispatchRow>();
  if (!dispatch) return json({ ok: false, error: "Trigger dispatch not found" }, { status: 404 });
  const durableLink = await env.DB.prepare(
    "SELECT run_id FROM control_durable_trigger_links WHERE dispatch_id=? AND user_id=? AND workspace_id=? AND agent_id=?",
  )
    .bind(dispatchId, identity.scope.userId, identity.scope.workspaceId, identity.agentId)
    .first();
  if (durableLink)
    return json(
      {
        ok: false,
        error: "Inspect the durable run; replay cannot create another run for this event.",
        code: "durable_dispatch_already_admitted",
      },
      { status: 409 },
    );
  if (dispatch.status !== "failed" && dispatch.status !== "cancelled") {
    return json(
      { ok: false, error: "Only failed or cancelled trigger dispatches can be replayed" },
      { status: 409 },
    );
  }
  const trigger = await findTrigger(env, identity, dispatch.trigger_id);
  if (!trigger) return json({ ok: false, error: "Trigger not found" }, { status: 404 });
  if (trigger.status !== "enabled")
    return json({ ok: false, error: "Trigger is not enabled" }, { status: 409 });
  const leaseOwner = `replay:${identity.scope.userId}:${crypto.randomUUID()}`;
  const now = new Date();
  const timestamp = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + 2 * 60 * 1000).toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE control_trigger_dispatches
       SET status = 'leased', attempt_count = attempt_count + 1,
           previous_run_id = run_id, run_id = NULL, lease_owner = ?, lease_expires_at = ?,
           heartbeat_at = ?, error_json = '{}', updated_at = ?
       WHERE user_id = ? AND workspace_id = ? AND agent_id = ? AND id = ?
         AND status IN ('failed', 'cancelled')
         AND EXISTS (
           SELECT 1 FROM control_triggers t
           WHERE t.id = ? AND t.user_id = ? AND t.workspace_id = ? AND t.agent_id = ?
             AND t.status = 'enabled'
             AND (
               SELECT COUNT(*) FROM control_trigger_dispatches active
               WHERE active.trigger_id = t.id AND active.status IN ('leased', 'running')
             ) < t.max_concurrent_runs
             AND (
               SELECT COUNT(*) FROM control_runs r
               WHERE r.user_id = t.user_id AND r.workspace_id = t.workspace_id
                 AND r.agent_id = t.agent_id
                 AND r.status IN ('queued', 'running', 'waiting', 'interrupted')
             ) < t.max_concurrent_runs
         )`,
    ).bind(
      leaseOwner,
      leaseExpiresAt,
      timestamp,
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      dispatchId,
      trigger.id,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
    ),
    env.DB.prepare(
      `INSERT INTO control_audit_events (
         id, user_id, workspace_id, action, summary, target_type, target_id,
         data_json, created_at
       ) SELECT ?, ?, ?, 'trigger.dispatch.replayed', ?, 'triggerDispatch', ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM control_trigger_dispatches
         WHERE user_id = ? AND workspace_id = ? AND id = ?
           AND status = 'leased' AND lease_owner = ? AND updated_at = ?
       )`,
    ).bind(
      createId("cf-audit"),
      identity.scope.userId,
      identity.scope.workspaceId,
      `Replayed trigger dispatch for ${trigger.pack_trigger_id}.`,
      dispatchId,
      toJson({ triggerId: trigger.id, previousRunId: dispatch.run_id }),
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      dispatchId,
      leaseOwner,
      timestamp,
    ),
  ]);
  if (changesOf(results[0]) !== 1)
    return json({ ok: false, error: "Trigger dispatch replay conflict" }, { status: 409 });
  if (ctx) {
    ctx.waitUntil(executeTriggerDispatchByLease(env, { dispatchId, leaseOwner }));
  }
  return json({
    ok: true,
    dispatch: {
      id: dispatchId,
      triggerId: trigger.id,
      status: "leased",
      attemptCount: dispatch.attempt_count + 1,
      previousRunId: dispatch.run_id ?? undefined,
    },
  });
};
