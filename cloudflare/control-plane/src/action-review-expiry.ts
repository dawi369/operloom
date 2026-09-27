import { actionEvidenceStatements, appendLedgerStatement } from "./action-authority-core";
import type { AgentIdentity, Env } from "./types";

/** Bounded expiry closes future authority; executing/accepted effects remain untouched. */
export const expireActionReviews = async (env: Env) => {
  const rows =
    await env.DB.prepare(`SELECT p.id,p.user_id,p.workspace_id,p.agent_id,p.approval_request_id,p.run_id,p.workflow_intent_id
    FROM control_action_proposals p JOIN control_action_reviews review ON review.proposal_id=p.id
    WHERE review.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND p.status IN ('approval_requested','approved')
    ORDER BY review.expires_at,review.id LIMIT 100`).all<{
      id: string;
      user_id: string;
      workspace_id: string;
      agent_id: string;
      approval_request_id: string;
      run_id: string;
      workflow_intent_id: string;
    }>();
  for (const row of rows.results) {
    const identity: AgentIdentity = {
      scope: { userId: row.user_id, workspaceId: row.workspace_id },
      agentId: row.agent_id,
    };
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`UPDATE control_action_proposals SET status='expired',terminal_at=?,updated_at=?,version=version+1,error_json='{"code":"action_review_expired"}'
        WHERE id=? AND status IN ('approval_requested','approved') AND EXISTS (SELECT 1 FROM control_action_reviews review
          WHERE review.proposal_id=control_action_proposals.id AND review.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).bind(
        now,
        now,
        row.id,
      ),
      env.DB.prepare(`UPDATE control_approval_requests SET status='expired',updated_at=? WHERE id=? AND status IN ('requested','approved')
        AND EXISTS (SELECT 1 FROM control_action_proposals WHERE id=? AND status='expired')`).bind(
        now,
        row.approval_request_id,
        row.id,
      ),
      env.DB.prepare(`UPDATE control_runs SET status='cancelled',cancelled_at=?,updated_at=? WHERE id=? AND status IN ('interrupted','running')
        AND EXISTS (SELECT 1 FROM control_action_proposals WHERE id=? AND status='expired')`).bind(
        now,
        now,
        row.run_id,
        row.id,
      ),
      env.DB.prepare(`UPDATE control_workflow_intents SET status='cancelled',updated_at=? WHERE id=? AND status IN ('interrupted','running')
        AND EXISTS (SELECT 1 FROM control_action_proposals WHERE id=? AND status='expired')`).bind(
        now,
        row.workflow_intent_id,
        row.id,
      ),
      appendLedgerStatement(env, identity, {
        proposalId: row.id,
        status: "cancelled",
        requiredStatus: "expired",
        requiredUpdatedAt: now,
        summary: "Action approval expired before dispatch.",
        timestamp: now,
      }),
      ...actionEvidenceStatements(env, identity, {
        proposalId: row.id,
        action: "action.expired",
        eventType: "action.expired",
        summary: "Action approval expired before dispatch.",
        status: "expired",
        timestamp: now,
      }),
    ]);
  }
  return { selected: rows.results.length };
};
