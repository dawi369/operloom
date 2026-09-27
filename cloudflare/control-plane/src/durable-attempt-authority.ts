import type { AgentIdentity, Env } from "./types";

/** Server-only authority. Packages never select an attempt or supply these pins. */
export type DurableAttemptAuthority = {
  runId: string;
  stepId: string;
  attemptId: string;
  definitionHash: string;
  workflowVersion: string;
  runtimeVersion: string;
  configurationHash: string;
};

export const durableExecutionLiveSql = (
  statuses = "'running'",
) => `SELECT 1 FROM control_durable_executions e
 JOIN control_runs r ON r.id=e.run_id AND r.user_id=e.user_id AND r.workspace_id=e.workspace_id AND r.agent_id=e.agent_id
 JOIN agents a ON a.id=e.agent_id AND a.workspace_id=e.workspace_id AND a.status='active'
   AND a.runtime_revision=e.agent_revision AND a.data_json=e.agent_data_json
 JOIN workspaces w ON w.id=e.workspace_id AND w.status='active'
 JOIN memberships m ON m.workspace_id=w.id AND m.user_id=e.user_id AND m.status='active'
 JOIN users u ON u.id=m.user_id AND u.status='active'
 WHERE e.run_id=? AND e.user_id=? AND e.workspace_id=? AND e.agent_id=? AND e.deadline>?
 AND e.deadline>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND e.status IN ('pending','started') AND r.status IN (${statuses})
 AND NOT EXISTS (SELECT 1 FROM control_durable_trigger_links l WHERE l.run_id=e.run_id AND NOT EXISTS (
   SELECT 1 FROM control_triggers t JOIN control_trigger_dispatches d ON d.trigger_id=t.id
   WHERE t.id=l.trigger_id AND d.id=l.dispatch_id AND d.run_id=e.run_id AND d.status='running'
     AND t.status='enabled' AND t.workflow_type=l.workflow_type AND t.pack_id=l.pack_id
     AND t.execution_json=l.execution_json AND t.input_json=l.input_json AND t.config_json=l.config_json
     AND m.role IN ('owner','admin')))
 AND NOT EXISTS (SELECT 1 FROM control_kill_switches k WHERE k.user_id=e.user_id AND k.workspace_id=e.workspace_id
   AND k.enabled=1 AND ((k.scope_kind='workspace' AND k.scope_id=e.workspace_id) OR (k.scope_kind='pack' AND k.scope_id=e.pack_id)))`;

/** Embed inside the transaction's CHECK-backed admission receipt, not an UPDATE that may affect zero rows. */
export const durableAttemptGuard = (
  identity: AgentIdentity,
  runId: string | undefined,
  attempt?: DurableAttemptAuthority,
) => {
  if (!attempt)
    return {
      sql: "NOT EXISTS (SELECT 1 FROM control_durable_executions WHERE run_id = ?)",
      values: [runId ?? null],
    };
  if (!runId || attempt.runId !== runId)
    throw Object.assign(new Error("Step authority must belong to the executing run"), {
      code: "durable_attempt_fenced",
    });
  return {
    sql: `EXISTS (${durableExecutionLiveSql()}
      AND e.status='started' AND e.definition_hash=? AND e.workflow_version=? AND e.runtime_version=? AND e.configuration_hash=?
      AND EXISTS (SELECT 1 FROM control_durable_steps s
        JOIN control_durable_step_attempts a ON a.id=s.active_attempt_id AND a.step_id=s.id AND a.run_id=s.run_id
          AND a.user_id=s.user_id AND a.workspace_id=s.workspace_id AND a.agent_id=s.agent_id
        WHERE s.id=? AND s.active_attempt_id=? AND s.run_id=e.run_id AND s.user_id=e.user_id
          AND s.workspace_id=e.workspace_id AND s.agent_id=e.agent_id
          AND s.status='running' AND a.status='running' AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
    values: [
      runId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      new Date().toISOString(),
      attempt.definitionHash,
      attempt.workflowVersion,
      attempt.runtimeVersion,
      attempt.configurationHash,
      attempt.stepId,
      attempt.attemptId,
    ],
  };
};

export const requireDurableAttemptAuthority = async (
  env: Env,
  identity: AgentIdentity,
  runId: string | undefined,
  attempt?: DurableAttemptAuthority,
) => {
  const guard = durableAttemptGuard(identity, runId, attempt);
  const allowed = await env.DB.prepare(`SELECT 1 WHERE ${guard.sql}`)
    .bind(...guard.values)
    .first();
  if (!allowed)
    throw Object.assign(new Error("The durable step attempt no longer holds execution authority"), {
      code: "durable_attempt_fenced",
    });
};
