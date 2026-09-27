import { coalesceDueOccurrence } from "./trigger-schedule";
import { processPendingTriggerDispatches } from "./trigger-execution";
import { recoverExpiredTriggerDispatches } from "./trigger-recovery";
import { parseDataJson } from "./http";
import { createId, toJson, type ControlTriggerRow, type Env } from "./types";

const maximumDuePerTick = 25;

export const dispatchDueTriggers = async (env: Env, input: { now?: Date; limit?: number } = {}) => {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? maximumDuePerTick), 1), 100);
  const due = await env.DB.prepare(
    `SELECT id, public_id, secret_hash, user_id, workspace_id, agent_id, pack_id, pack_trigger_id, kind,
            workflow_type, status, execution_json, config_json, input_json,
            max_concurrent_runs, version, next_trigger_at, last_triggered_at,
            created_by_user_id, created_at, updated_at
     FROM control_triggers
     WHERE status = 'enabled' AND kind IN ('schedule', 'monitor')
       AND next_trigger_at IS NOT NULL AND next_trigger_at <= ?
     ORDER BY next_trigger_at ASC
     LIMIT ?`,
  )
    .bind(timestamp, limit)
    .all<ControlTriggerRow>();

  let created = 0;
  for (const trigger of due.results) {
    if (!trigger.next_trigger_at) continue;
    const config = parseDataJson(trigger.config_json) as {
      cron?: string;
      timezone?: string;
      intervalSeconds?: number;
    };
    const occurrence = coalesceDueOccurrence({
      kind: trigger.kind === "schedule" ? "schedule" : "monitor",
      config,
      scheduledFor: new Date(trigger.next_trigger_at),
      now,
    });
    if (!occurrence.due) continue;
    const dispatchId = createId("cf-dispatch");
    const idempotencyKey = `${trigger.kind}:${trigger.id}:${occurrence.scheduledFor.toISOString()}`;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE control_triggers
         SET next_trigger_at = ?, last_triggered_at = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?
           AND status = 'enabled' AND next_trigger_at = ?`,
      ).bind(
        occurrence.nextTriggerAt.toISOString(),
        timestamp,
        timestamp,
        trigger.id,
        trigger.user_id,
        trigger.workspace_id,
        trigger.agent_id,
        trigger.next_trigger_at,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO control_trigger_dispatches (
           id, trigger_id, user_id, workspace_id, agent_id, idempotency_key, source,
           status, attempt_count, scheduled_for, received_at, payload_json, error_json,
           created_at, updated_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, '{}', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM control_triggers
           WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?
             AND status = 'enabled' AND updated_at = ? AND next_trigger_at = ?
         )`,
      ).bind(
        dispatchId,
        trigger.id,
        trigger.user_id,
        trigger.workspace_id,
        trigger.agent_id,
        idempotencyKey,
        trigger.kind,
        occurrence.scheduledFor.toISOString(),
        timestamp,
        toJson({ skippedOccurrences: occurrence.skippedOccurrences }),
        timestamp,
        timestamp,
        trigger.id,
        trigger.user_id,
        trigger.workspace_id,
        trigger.agent_id,
        timestamp,
        occurrence.nextTriggerAt.toISOString(),
      ),
    ]);
    // D1 changes includes coalescing/validation trigger writes. Only the new ID
    // establishes that this tick created a dispatch rather than updating one.
    if (
      await env.DB.prepare("SELECT id FROM control_trigger_dispatches WHERE id=?")
        .bind(dispatchId)
        .first()
    )
      created += 1;
  }
  return { inspected: due.results.length, created };
};

export const runTriggerSchedulerTick = async (
  env: Env,
  input: { now?: Date; leaseOwner?: string } = {},
) => {
  const now = input.now ?? new Date();
  const leaseOwner = input.leaseOwner ?? `scheduler:${crypto.randomUUID()}`;
  const recovery = await recoverExpiredTriggerDispatches(env, { now });
  const due = await dispatchDueTriggers(env, { now });
  const execution = await processPendingTriggerDispatches(env, { leaseOwner, limit: 10 });
  return { recovery, due, execution };
};
