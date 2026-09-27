import {
  buildPackWorkflowRequest,
  packWorkflowBindings,
  type PackWorkflowType,
} from "../../../lib/agent-runtime/registry";
import { parseDataJson } from "./http";
import { prepareOperatorAlertStatement } from "./operator-alerts";
import { TriggerDispatchLeaseLostError } from "./runtime-run-lifecycle";
import { executeRuntimeWorkflow } from "./pack-workflow-runtime";
import {
  createId,
  toJson,
  type AgentIdentity,
  type ControlTriggerDispatchRow,
  type ControlTriggerRow,
  type Env,
} from "./types";

const leaseDurationMs = 2 * 60 * 1000;
const defaultLeaseLimit = 10;

export type LeasedTriggerDispatch = {
  trigger: ControlTriggerRow;
  dispatch: ControlTriggerDispatchRow;
};

const readLeasedDispatch = async (env: Env, dispatchId: string, leaseOwner: string) => {
  const dispatchRow = await env.DB.prepare(
    `SELECT id, trigger_id, user_id, workspace_id, agent_id, idempotency_key, source, status,
            attempt_count, run_id, previous_run_id, scheduled_for, received_at, lease_owner,
            lease_expires_at, heartbeat_at, payload_json, error_json, created_at, updated_at
     FROM control_trigger_dispatches
     WHERE id = ? AND status = 'leased' AND lease_owner = ? LIMIT 1`,
  )
    .bind(dispatchId, leaseOwner)
    .first<ControlTriggerDispatchRow>();
  if (!dispatchRow) return null;
  const triggerRow = await env.DB.prepare(
    `SELECT id, public_id, secret_hash, user_id, workspace_id, agent_id, pack_id, pack_trigger_id, kind,
            workflow_type, status, execution_json, config_json, input_json,
            max_concurrent_runs, version, next_trigger_at, last_triggered_at,
            created_by_user_id, created_at, updated_at
     FROM control_triggers
     WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?
       AND status = 'enabled' LIMIT 1`,
  )
    .bind(
      dispatchRow.trigger_id,
      dispatchRow.user_id,
      dispatchRow.workspace_id,
      dispatchRow.agent_id,
    )
    .first<ControlTriggerRow>();
  return dispatchRow && triggerRow ? { trigger: triggerRow, dispatch: dispatchRow } : null;
};

export const leasePendingTriggerDispatches = async (
  env: Env,
  input: { leaseOwner: string; now?: Date; limit?: number; dispatchId?: string },
) => {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? defaultLeaseLimit), 1), 25);
  const candidates = await env.DB.prepare(
    `SELECT d.id
     FROM control_trigger_dispatches d
     INNER JOIN control_triggers t ON t.id = d.trigger_id
     WHERE d.status = 'pending' AND t.status = 'enabled'
       AND (? IS NULL OR d.id = ?)
     ORDER BY d.received_at ASC
     LIMIT ?`,
  )
    .bind(input.dispatchId ?? null, input.dispatchId ?? null, limit)
    .all<{ id: string }>();

  const leased: LeasedTriggerDispatch[] = [];
  for (const candidate of candidates.results) {
    const result = await env.DB.prepare(
      `UPDATE control_trigger_dispatches
       SET status = 'leased', attempt_count = attempt_count + 1, lease_owner = ?,
           lease_expires_at = ?, heartbeat_at = ?, error_json = '{}', updated_at = ?
       WHERE id = ? AND status = 'pending'
         AND EXISTS (
           SELECT 1 FROM control_triggers t
           WHERE t.id = control_trigger_dispatches.trigger_id AND t.status = 'enabled'
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
    )
      .bind(input.leaseOwner, leaseExpiresAt, timestamp, timestamp, candidate.id)
      .run();
    if ((result as { meta?: { changes?: number } }).meta?.changes !== 1) continue;
    const row = await readLeasedDispatch(env, candidate.id, input.leaseOwner);
    if (row) leased.push(row);
  }
  return leased;
};

const failUnfinishedDispatch = async (
  env: Env,
  item: LeasedTriggerDispatch,
  error: { code: string; message: string },
) => {
  const timestamp = new Date().toISOString();
  const failureCondition = `EXISTS (
    SELECT 1 FROM control_trigger_dispatches
    WHERE id = ? AND user_id = ? AND workspace_id = ?
      AND status = 'failed' AND updated_at = ?
  )`;
  const failureBindings = [
    item.dispatch.id,
    item.dispatch.user_id,
    item.dispatch.workspace_id,
    timestamp,
  ];
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE control_trigger_dispatches
       SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
           error_json = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ?
         AND status IN ('leased', 'running') AND lease_owner = ? AND attempt_count = ?`,
    ).bind(
      toJson(error),
      timestamp,
      item.dispatch.id,
      item.dispatch.user_id,
      item.dispatch.workspace_id,
      item.dispatch.lease_owner,
      item.dispatch.attempt_count,
    ),
    env.DB.prepare(
      `INSERT INTO control_audit_events (
         id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
       ) SELECT ?, ?, ?, 'trigger.dispatch.failed', ?, 'triggerDispatch', ?, ?, ?
       WHERE ${failureCondition}`,
    ).bind(
      createId("cf-audit"),
      item.dispatch.user_id,
      item.dispatch.workspace_id,
      error.message,
      item.dispatch.id,
      toJson({ triggerId: item.trigger.id, errorCode: error.code }),
      timestamp,
      ...failureBindings,
    ),
    prepareOperatorAlertStatement(env, {
      userId: item.dispatch.user_id,
      workspaceId: item.dispatch.workspace_id,
      agentId: item.dispatch.agent_id,
      severity: "critical",
      code: error.code,
      summary: error.message,
      targetType: "triggerDispatch",
      targetId: item.dispatch.id,
      dedupKey: `trigger-dispatch:${item.dispatch.id}:${error.code}`,
      data: { triggerId: item.trigger.id, attemptCount: item.dispatch.attempt_count },
      timestamp,
      conditionSql: failureCondition,
      conditionBindings: failureBindings,
    }),
  ]);
};

export const executeLeasedTriggerDispatch = async (env: Env, item: LeasedTriggerDispatch) => {
  const binding = packWorkflowBindings[item.trigger.workflow_type as PackWorkflowType];
  if (!binding || binding.requiredPackId !== item.trigger.pack_id) {
    await failUnfinishedDispatch(env, item, {
      code: "trigger_binding_unavailable",
      message: "The registered trigger workflow is unavailable.",
    });
    return { ok: false as const, code: "trigger_binding_unavailable" };
  }
  const callbackUrl = env.OPERLOOM_CALLBACK_URL?.trim();
  const durable = parseDataJson(item.trigger.execution_json).runtime === "durable";
  if (!callbackUrl && !durable) {
    await failUnfinishedDispatch(env, item, {
      code: "trigger_callback_unavailable",
      message: "The trigger callback URL is not configured.",
    });
    return { ok: false as const, code: "trigger_callback_unavailable" };
  }
  const triggerInput = parseDataJson(item.trigger.input_json);
  const dispatchPayload = parseDataJson(item.dispatch.payload_json);
  let request;
  try {
    // Schedule and monitor payloads hold scheduler bookkeeping, not workflow input.
    request = buildPackWorkflowRequest(item.trigger.workflow_type, {
      ...triggerInput,
      ...(["schedule", "monitor"].includes(item.dispatch.source) ? {} : dispatchPayload),
    });
  } catch {
    request = null;
  }
  if (!request) {
    await failUnfinishedDispatch(env, item, {
      code: "trigger_input_invalid",
      message: "The trigger workflow input is invalid.",
    });
    return { ok: false as const, code: "trigger_input_invalid" };
  }
  const identity: AgentIdentity = {
    scope: { userId: item.trigger.user_id, workspaceId: item.trigger.workspace_id },
    agentId: item.trigger.agent_id,
  };
  try {
    const response = await executeRuntimeWorkflow(
      item.trigger.workflow_type,
      new Request(new URL(binding.workerRoute, callbackUrl ?? "https://operloom.internal"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...request, ...(durable ? { execution: "durable" } : {}) }),
      }),
      env,
      identity,
      {
        source: "trigger",
        triggerId: item.trigger.id,
        packTriggerId: item.trigger.pack_trigger_id,
        dispatchId: item.dispatch.id,
        leaseOwner: item.dispatch.lease_owner ?? "",
        triggerSource: item.dispatch.source,
        attemptCount: item.dispatch.attempt_count,
        idempotencyKey: item.dispatch.idempotency_key,
        scheduledFor: item.dispatch.scheduled_for,
        previousRunId: item.dispatch.previous_run_id,
        triggerSnapshot: {
          inputJson: item.trigger.input_json,
          executionJson: item.trigger.execution_json,
          configJson: item.trigger.config_json,
          payloadJson: item.dispatch.payload_json,
        },
      },
    );
    if (!response.ok) {
      await failUnfinishedDispatch(env, item, {
        code: "trigger_workflow_rejected",
        message: "The trigger workflow rejected the dispatch.",
      });
    }
    return { ok: response.ok, status: response.status };
  } catch (error) {
    if (error instanceof TriggerDispatchLeaseLostError) {
      return { ok: false as const, code: error.code };
    }
    await failUnfinishedDispatch(env, item, {
      code: "trigger_execution_failed",
      message: "The trigger workflow could not be executed.",
    });
    return { ok: false as const, code: "trigger_execution_failed" };
  }
};

export const executeTriggerDispatchByLease = async (
  env: Env,
  input: { dispatchId: string; leaseOwner: string },
) => {
  const item = await readLeasedDispatch(env, input.dispatchId, input.leaseOwner);
  return item
    ? executeLeasedTriggerDispatch(env, item)
    : { ok: false as const, code: "trigger_dispatch_lease_lost" };
};

export const processPendingTriggerDispatches = async (
  env: Env,
  input: { leaseOwner: string; dispatchId?: string; limit?: number },
) => {
  const leased = await leasePendingTriggerDispatches(env, input);
  const results = [];
  for (const item of leased) results.push(await executeLeasedTriggerDispatch(env, item));
  return { leased: leased.length, results };
};
