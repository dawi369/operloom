import { sha256Hex } from "../../../lib/workbench/control-plane-signing";
import { durableExecutionLiveSql } from "./durable-attempt-authority";
import { runtimeStateCanonicalJson } from "./runtime-state";
import { activeRunStatusSql } from "./run-transitions";
import type { DurableExecution } from "./durable-execution-store";
import { createId, type Env } from "./types";

export type DurableRecovery = DurableExecution & {
  recovery_attempts: number;
  recovery_lease_id: string;
  recovery_lease_expires_at: string;
  run_status: string;
};
export type RecoveryReason =
  | "durable_deadline_exceeded"
  | "durable_authority_revoked"
  | "durable_engine_errored"
  | "durable_engine_terminated"
  | "durable_projection_missing";

const clock = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const owned = `SELECT 1 FROM control_durable_executions e WHERE e.run_id=? AND e.recovery_lease_id=?`;
const held = `${owned} AND e.recovery_lease_expires_at>${clock}`;
const active = `${owned} AND e.status!='closed' AND EXISTS (SELECT 1 FROM control_runs r
 WHERE r.id=e.run_id AND r.user_id=e.user_id AND r.workspace_id=e.workspace_id
 AND r.agent_id=e.agent_id AND r.status IN ${activeRunStatusSql})`;
const values = (row: DurableRecovery) => [row.run_id, row.recovery_lease_id];

export const listDueDurableRecoveries = (env: Env) =>
  env.DB.prepare(`SELECT run_id FROM control_durable_executions e
    WHERE recovery_next_at<=${clock}
    AND (recovery_lease_expires_at IS NULL OR recovery_lease_expires_at<=${clock})
    AND NOT EXISTS (SELECT 1 FROM control_workspace_write_fences fence WHERE fence.workspace_id=e.workspace_id
      AND fence.status='active' AND fence.lease_expires_at>${clock})
    ORDER BY recovery_next_at,run_id LIMIT 16`).all<{ run_id: string }>();

export const claimDurableRecovery = async (env: Env, runId: string) => {
  const leaseId = createId("durable-recovery");
  await env.DB.prepare(`UPDATE control_durable_executions SET
    recovery_lease_id=?,recovery_lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+90 seconds'),
    recovery_next_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+90 seconds'),
    recovery_attempts=recovery_attempts+1
    WHERE run_id=? AND recovery_next_at<=${clock}
    AND (recovery_lease_expires_at IS NULL OR recovery_lease_expires_at<=${clock})`)
    .bind(leaseId, runId)
    .run();
  return env.DB.prepare(`SELECT e.*,r.status run_status FROM control_durable_executions e
    JOIN control_runs r ON r.id=e.run_id AND r.user_id=e.user_id AND r.workspace_id=e.workspace_id AND r.agent_id=e.agent_id
    WHERE e.run_id=? AND e.recovery_lease_id=?`)
    .bind(runId, leaseId)
    .first<DurableRecovery>();
};

export const durableRecoveryFenceReason = async (env: Env, row: DurableRecovery) => {
  if (row.status === "closed") return null;
  const allowed = await env.DB.prepare(`SELECT
    CASE WHEN e.deadline<=${clock} THEN 'durable_deadline_exceeded'
    WHEN NOT EXISTS (${durableExecutionLiveSql("'queued','running','waiting','interrupted'")})
    THEN 'durable_authority_revoked' END reason
    FROM control_durable_executions e WHERE e.run_id=? AND e.status!='closed'`)
    .bind(
      row.run_id,
      row.user_id,
      row.workspace_id,
      row.agent_id,
      new Date().toISOString(),
      row.run_id,
    )
    .first<{ reason: RecoveryReason | null }>();
  return allowed?.reason ?? null;
};

/** System reconciliation may close revoked work, but never grants execution authority. */
export const closeDurableRecovery = async (
  env: Env,
  row: DurableRecovery,
  reason: RecoveryReason,
) => {
  const now = new Date().toISOString();
  const status = reason === "durable_deadline_exceeded" ? "failed" : "blocked";
  const data = JSON.stringify({
    durableRecoveryLease: row.recovery_lease_id,
    error: {
      code: reason,
      message: "Durable execution stopped; inspect its recorded steps before reconciliation.",
    },
  });
  const condition =
    reason === "durable_deadline_exceeded"
      ? ` AND e.deadline<=${clock}`
      : reason === "durable_authority_revoked"
        ? ` AND NOT EXISTS (${durableExecutionLiveSql("'queued','running','waiting','interrupted'")})`
        : "";
  const reasonValues =
    reason === "durable_authority_revoked"
      ? [row.run_id, row.user_id, row.workspace_id, row.agent_id, now]
      : [];
  // This first guarded write and every projection share one transaction. A late event failure rolls it all back.
  const results = await env.DB.batch([
    guardLease(env, row),
    env.DB.prepare(`UPDATE control_durable_executions SET preconditions_met=CASE WHEN EXISTS (${active}${condition}) THEN 1 ELSE 0 END
      WHERE run_id=? AND status!='closed'`).bind(...values(row), ...reasonValues, row.run_id),
    env.DB.prepare(`UPDATE control_workflow_intents SET status=?,updated_at=?
      WHERE id=? AND user_id=? AND workspace_id=? AND agent_id=? AND EXISTS (${active})`).bind(
      status,
      now,
      row.workflow_intent_id,
      row.user_id,
      row.workspace_id,
      row.agent_id,
      ...values(row),
    ),
    env.DB.prepare(`UPDATE control_runs SET status=?,updated_at=?,failed_at=?,last_event_at=?,data_json=json_patch(data_json,?)
      WHERE id=? AND user_id=? AND workspace_id=? AND agent_id=? AND EXISTS (${active})`).bind(
      status,
      now,
      now,
      now,
      data,
      row.run_id,
      row.user_id,
      row.workspace_id,
      row.agent_id,
      ...values(row),
    ),
    env.DB.prepare(`INSERT INTO control_plane_events (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
      SELECT ?,?,?,?,?,'Durable execution requires reconciliation.','run',?,?,? WHERE EXISTS (
      SELECT 1 FROM control_runs WHERE id=? AND json_extract(data_json,'$.durableRecoveryLease')=?)
      AND NOT EXISTS (SELECT 1 FROM control_plane_events WHERE id=?)`).bind(
      `${row.run_id}:terminal`,
      row.user_id,
      row.workspace_id,
      row.agent_id,
      `workflow.run.${status}`,
      row.run_id,
      data,
      now,
      row.run_id,
      row.recovery_lease_id,
      `${row.run_id}:terminal`,
    ),
    ...(await unknownAttemptStatements(env, row, "durable_execution_stopped")),
  ]);
  // Closing this one run also fires lifecycle projection triggers in D1.
  return (results[3]?.meta?.changes ?? 0) > 0;
};

const unknownAttemptStatements = async (env: Env, row: DurableRecovery, code: string) => {
  const now = new Date().toISOString();
  const outcomeHash = await sha256Hex(
    runtimeStateCanonicalJson({ status: "outcome_unknown", errorCode: code }),
  );
  const closed = `${owned} AND e.status='closed'`;
  return [
    env.DB.prepare(`INSERT INTO control_durable_step_outcomes
      (id,user_id,workspace_id,agent_id,run_id,step_id,outcome_hash,status,created_at,preconditions_met)
      SELECT id,user_id,workspace_id,agent_id,run_id,step_id,?,'outcome_unknown',?,1 FROM control_durable_step_attempts
      WHERE run_id=? AND status='running' AND EXISTS (${closed})`).bind(
      outcomeHash,
      now,
      row.run_id,
      ...values(row),
    ),
    env.DB.prepare(`INSERT INTO control_plane_events (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
      SELECT id||':finished',user_id,workspace_id,agent_id,'workflow.step.finished','Interrupted step outcome is unknown.','run',run_id,
      json_object('stepId',step_id,'attemptId',id,'status','outcome_unknown','errorCode',?),?
      FROM control_durable_step_attempts WHERE run_id=? AND status='running' AND EXISTS (${closed})`).bind(
      code,
      now,
      row.run_id,
      ...values(row),
    ),
    env.DB.prepare(`UPDATE control_durable_step_attempts SET status='outcome_unknown',outcome_hash=?,error_code=?,finished_at=?
      WHERE run_id=? AND status='running' AND EXISTS (${closed})`).bind(
      outcomeHash,
      code,
      now,
      row.run_id,
      ...values(row),
    ),
    env.DB.prepare(`UPDATE control_durable_steps SET status='outcome_unknown',updated_at=?
      WHERE run_id=? AND status='running' AND EXISTS (${closed})`).bind(
      now,
      row.run_id,
      ...values(row),
    ),
  ];
};

const guardLease = (env: Env, row: DurableRecovery) =>
  env.DB.prepare(`UPDATE control_durable_executions
  SET recovery_attempts=CASE WHEN EXISTS (${held}) THEN recovery_attempts ELSE -1 END WHERE run_id=?`).bind(
    ...values(row),
    row.run_id,
  );

export const settleClosedDurableAttempts = async (env: Env, row: DurableRecovery) =>
  env.DB.batch([
    guardLease(env, row),
    ...(await unknownAttemptStatements(env, row, "durable_execution_stopped")),
  ]);

export const releaseDurableRecovery = (
  env: Env,
  row: DurableRecovery,
  result: {
    engineStatus: string | null;
    errorCode: string | null;
    done: boolean;
  },
) => {
  // Failed provider calls rotate behind untouched rows, with a bounded 30s..15m backoff.
  const delay = result.errorCode
    ? Math.min(900, 30 * 2 ** Math.min(row.recovery_attempts - 1, 5))
    : 60;
  return env.DB.prepare(`UPDATE control_durable_executions SET recovery_lease_id=NULL,recovery_lease_expires_at=NULL,
    recovery_next_at=?,recovery_attempts=CASE WHEN ? IS NULL THEN 0 ELSE recovery_attempts END,
    recovery_engine_status=?,recovery_error_code=?
    WHERE run_id=? AND recovery_lease_id=? AND recovery_lease_expires_at>${clock}`)
    .bind(
      result.done ? null : new Date(Date.now() + delay * 1000).toISOString(),
      result.errorCode,
      result.engineStatus,
      result.errorCode,
      ...values(row),
    )
    .run();
};
