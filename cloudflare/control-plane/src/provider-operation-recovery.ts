import type { ActionExecutionResult } from "@operloom/agent-sdk/control-plane";
import { actionEvidenceStatements } from "./action-authority-core";
import { createId, type AgentIdentity, type ControlActionProposalRow, type Env } from "./types";

/** Resolve absence only while fencing the same proposal version against future admission. */
export const recoverUndispatchedProviderAction = async (
  env: Env,
  identity: AgentIdentity,
  row: ControlActionProposalRow,
): Promise<ActionExecutionResult | null> => {
  const result: ActionExecutionResult = {
    proposalId: row.id,
    status: "reconciled",
    summary: "No provider mutation was dispatched; execution was fenced.",
    output: { dispatchStatus: "not_dispatched" },
  };
  if (row.status === "reconciled") {
    const output = JSON.parse(row.result_json) as Record<string, unknown>;
    return output.dispatchStatus === "not_dispatched"
      ? result
      : {
          proposalId: row.id,
          status: "reconciled",
          summary: "Action reconciliation is already complete.",
          output,
        };
  }
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO control_action_ledger
        (id,user_id,workspace_id,agent_id,proposal_id,sequence,status,summary,data_json,created_at,transition_key,preconditions_met)
        VALUES (?,?,?,?,?,COALESCE((SELECT MAX(sequence) FROM control_action_ledger WHERE proposal_id=?),0)+1,
        'reconciled',?,?,?,'provider:not-dispatched',CASE WHEN EXISTS (
          SELECT 1 FROM control_action_proposals p
          JOIN workspaces w ON w.id=p.workspace_id AND w.status='active'
          JOIN users u ON u.id=p.user_id AND u.status='active'
          JOIN memberships m ON m.user_id=p.user_id AND m.workspace_id=p.workspace_id AND m.status='active' AND m.role IN ('owner','admin')
          JOIN agents a ON a.id=p.agent_id AND a.workspace_id=p.workspace_id AND a.status='active'
          WHERE p.id=? AND p.user_id=? AND p.workspace_id=? AND p.agent_id=? AND p.version=?
          AND p.status IN ('executing','outcome_unknown')
          AND NOT EXISTS (SELECT 1 FROM control_provider_operations o WHERE o.proposal_id=p.id)
        ) THEN 1 ELSE 0 END)`).bind(
        createId("cf-action-ledger"),
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        row.id,
        row.id,
        result.summary,
        JSON.stringify(result.output),
        now,
        row.id,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        row.version,
      ),
      env.DB.prepare(`UPDATE control_action_proposals SET status='reconciled',result_json=?,error_json='{}',
        terminal_at=?,updated_at=?,version=version+1 WHERE id=? AND user_id=? AND workspace_id=? AND agent_id=?`).bind(
        JSON.stringify(result.output),
        now,
        now,
        row.id,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
      ),
      env.DB.prepare(`UPDATE control_runs SET status='failed',failed_at=?,last_event_at=?,updated_at=?,
        data_json=json_set(data_json,'$.summary',?,'$.actionProposalId',?)
        WHERE id=? AND user_id=? AND workspace_id=? AND agent_id=? AND status IN ('running','failed')`).bind(
        now,
        now,
        now,
        result.summary,
        row.id,
        row.run_id,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
      ),
      env.DB.prepare(`UPDATE control_workflow_intents SET status='failed',updated_at=?
        WHERE id=? AND user_id=? AND workspace_id=? AND agent_id=? AND status IN ('running','failed')`).bind(
        now,
        row.workflow_intent_id,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
      ),
      ...actionEvidenceStatements(env, identity, {
        proposalId: row.id,
        action: "action.reconciled",
        eventType: "action.reconciled",
        summary: result.summary,
        status: "reconciled",
        timestamp: now,
        data: result.output,
      }),
    ]);
    return result;
  } catch (error) {
    // A competing admission/recovery or authority change leaves the whole batch unchanged.
    if (
      error instanceof Error &&
      /action_transition_precondition|CHECK constraint|UNIQUE constraint/.test(error.message)
    )
      return null;
    throw error;
  }
};
