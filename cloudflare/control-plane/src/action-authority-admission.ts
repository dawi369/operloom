import type { ActionExecutionResult } from "@operloom/agent-sdk/control-plane";
import { actionEvidenceStatements, appendLedgerStatement } from "./action-authority-core";
import type { ActionReview } from "./action-review";
import {
  effectTargetOf,
  toJson,
  type AgentIdentity,
  type ControlActionProposalRow,
  type D1PreparedStatement,
  type Env,
} from "./types";

/**
 * Records that a proposal left `proposed`. `requested` parks it on a human
 * approval; `auto` approves it under the action's declared policy so execution
 * can follow in the same call. Both forms create the run, intent and approval
 * request the operations surfaces expect.
 */
export const actionAdmissionStatements = (
  env: Env,
  identity: AgentIdentity,
  row: ControlActionProposalRow,
  input: {
    approval: "requested" | "auto";
    approvalId: string;
    runId: string;
    intentId: string;
    review: ActionReview;
    policyDecisionId: string;
    timestamp: string;
  },
): D1PreparedStatement[] => {
  const auto = input.approval === "auto";
  const { approvalId, runId, intentId, review, timestamp } = input;
  return [
    env.DB.prepare(
      `UPDATE control_action_proposals SET status = ?, approval_request_id = ?,
         policy_decision_id = ?, run_id = ?, workflow_intent_id = ?, version = version + 1,
         updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'proposed' AND version = ?`,
    ).bind(
      auto ? "approved" : "approval_requested",
      approvalId,
      input.policyDecisionId,
      runId,
      intentId,
      timestamp,
      row.id,
      identity.scope.userId,
      identity.scope.workspaceId,
      row.version,
    ),
    env.DB.prepare(
      `INSERT INTO control_workflow_intents (id, user_id, workspace_id, agent_id, stage, type,
         execution_json, payload_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'act', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      intentId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      `action.${row.action_type}`,
      toJson({ mode: "execute" }),
      toJson({ actionProposalId: row.id }),
      auto ? "running" : "interrupted",
      timestamp,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO control_runs (id, user_id, workspace_id, agent_id, workflow_intent_id, status,
         execution_json, stage, engine, heartbeat_at, last_event_at, data_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'act', 'cloudflare', ?, ?, ?, ?, ?)`,
    ).bind(
      runId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      intentId,
      auto ? "running" : "interrupted",
      toJson({ mode: "execute" }),
      timestamp,
      timestamp,
      toJson({
        displayName: row.summary,
        actionProposalId: row.id,
        summary: auto ? "Action approved by policy." : "Action approval required.",
        agentRevision: identity.agentRevision ?? 0,
        effectTarget: effectTargetOf(identity),
        ...(auto ? { approval: "auto" } : {}),
      }),
      timestamp,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO control_approval_requests (id, user_id, workspace_id, agent_id, workflow_intent_id,
         run_id, tool_id, status, reason, data_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      approvalId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      intentId,
      runId,
      row.tool_id,
      auto ? "approved" : "requested",
      auto
        ? "Approved by action policy within declared limits."
        : "External mutation requires approval.",
      toJson({
        actionProposalId: row.id,
        source: "action_authority",
        ...(auto ? { approval: "auto" } : {}),
        actionReviewHash: review.request_hash,
        expiresAt: review.expires_at,
      }),
      timestamp,
      timestamp,
    ),
    appendLedgerStatement(env, identity, {
      proposalId: row.id,
      status: auto ? "approved" : "blocked",
      requiredStatus: auto ? "approved" : "approval_requested",
      requiredUpdatedAt: timestamp,
      summary: auto
        ? "Action approved by policy within declared limits."
        : "Action is waiting for approval.",
      timestamp,
    }),
    ...actionEvidenceStatements(env, identity, {
      proposalId: row.id,
      action: auto ? "action.approved" : "action.approval_requested",
      eventType: auto ? "action.approved" : "action.approval.requested",
      summary: auto
        ? "External mutation approved by action policy."
        : "External mutation is waiting for workspace approval.",
      status: auto ? "approved" : "approval_requested",
      timestamp,
      data: { approvalRequestId: approvalId, runId, ...(auto ? { approval: "auto" } : {}) },
    }),
  ];
};

const runOutcome = (status: ActionExecutionResult["status"]) =>
  status === "executed" || status === "reconciled" ? "completed" : "failed";

/** Closes the action run and intent opened at admission with the dispatch outcome. */
export const completeActionRun = (
  env: Env,
  identity: AgentIdentity,
  input: { runId: string; intentId: string; proposalId: string; result: ActionExecutionResult },
) => {
  const completedAt = new Date().toISOString();
  const outcome = runOutcome(input.result.status);
  return env.DB.batch([
    env.DB.prepare(
      `UPDATE control_runs SET status = ?, completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
         failed_at = CASE WHEN ? = 'failed' THEN ? ELSE failed_at END, last_event_at = ?,
         data_json = json_set(data_json, '$.summary', ?, '$.actionProposalId', ?), updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'running'`,
    ).bind(
      outcome,
      outcome,
      completedAt,
      outcome,
      completedAt,
      completedAt,
      input.result.summary,
      input.proposalId,
      completedAt,
      input.runId,
      identity.scope.userId,
      identity.scope.workspaceId,
    ),
    env.DB.prepare(
      `UPDATE control_workflow_intents SET status = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'running'`,
    ).bind(outcome, completedAt, input.intentId, identity.scope.userId, identity.scope.workspaceId),
  ]);
};
