import { isRecord, json, parseDataJson } from "./http";
import { selectMembership } from "./authz-store";
import { requireAdminMembership } from "./membership-policy";
import { prepareOperatorAlertStatement } from "./operator-alerts";
import { dispatchWorkbenchSessionEvent } from "./session-coordinator";
import {
  createId,
  effectTargetOf,
  toJson,
  type AgentIdentity,
  type ControlActionProposalRow,
  type ControlApprovalRequestRow,
  type Env,
} from "./types";
import {
  actionEvidenceStatements,
  appendLedgerStatement,
  evaluateActionPolicy,
  mutationPreflight,
  proposalColumns,
  selectProposal,
} from "./action-authority-core";
import { executeActionProposal, reconcileActionProposal } from "./action-authority-execution";
import { enqueueNotificationEvent } from "./notification-delivery";
import {
  actionReviewTransition,
  commitActionReviewBatch,
  createActionReview,
  insertActionReview,
  loadActionReview,
  type ActionReview,
} from "./action-review";

const reviewFailure = (error: unknown) =>
  json(
    {
      ok: false,
      code:
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "action_review_failed",
      error:
        error instanceof Error && "code" in error
          ? error.message
          : "Action review could not be completed.",
    },
    { status: 409 },
  );

const dispatchActionUpdate = async (
  env: Env,
  identity: AgentIdentity,
  input: { proposalId: string; status: string; approvalRequestId?: string; runId?: string },
) => {
  await dispatchWorkbenchSessionEvent(env, identity, {
    type: "action.updated",
    data: input,
  });
  await enqueueNotificationEvent(env, identity, {
    type: "action.updated",
    targetType: "actionProposal",
    targetId: input.proposalId,
    data: { status: input.status },
  });
};

export const handleListActionProposals = async (env: Env, identity: AgentIdentity, url: URL) => {
  const requested = Number(url.searchParams.get("limit") ?? 25);
  const limit = Math.max(1, Math.min(100, Number.isFinite(requested) ? requested : 25));
  const rows = await env.DB.prepare(
    `SELECT ${proposalColumns} FROM control_action_proposals
     WHERE user_id = ? AND workspace_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, identity.agentId, limit)
    .all<ControlActionProposalRow>();
  const proposalIds = rows.results.map((row) => row.id);
  const ledger = proposalIds.length
    ? await env.DB.prepare(
        `SELECT proposal_id, sequence, status, summary, external_reference, created_at
         FROM control_action_ledger
         WHERE user_id = ? AND workspace_id = ? AND agent_id = ?
           AND proposal_id IN (SELECT value FROM json_each(?))
         ORDER BY proposal_id, sequence ASC`,
      )
        .bind(
          identity.scope.userId,
          identity.scope.workspaceId,
          identity.agentId,
          JSON.stringify(proposalIds),
        )
        .all<{
          proposal_id: string;
          sequence: number;
          status: string;
          summary: string;
          external_reference: string | null;
          created_at: string;
        }>()
    : { results: [] };
  const reviews =
    await env.DB.prepare(`SELECT proposal_id,request_hash,expires_at FROM control_action_reviews
    WHERE user_id=? AND workspace_id=? AND agent_id=? AND proposal_id IN (SELECT value FROM json_each(?))`)
      .bind(
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        JSON.stringify(proposalIds),
      )
      .all<{ proposal_id: string; request_hash: string; expires_at: string }>();
  const operations =
    await env.DB.prepare(`SELECT id,proposal_id,operation_id,operation_version,status,result_json,updated_at
    FROM control_provider_operations WHERE user_id=? AND workspace_id=? AND agent_id=?
    AND proposal_id IN (SELECT value FROM json_each(?))`)
      .bind(
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        JSON.stringify(proposalIds),
      )
      .all<{
        id: string;
        proposal_id: string;
        operation_id: string;
        operation_version: string;
        status: string;
        result_json: string;
        updated_at: string;
      }>();
  return json({
    ok: true,
    proposals: rows.results.map((row) => ({
      id: row.id,
      toolId: row.tool_id,
      actionType: row.action_type,
      status: row.status,
      summary: row.summary,
      proposal: JSON.parse(row.proposal_json),
      result: JSON.parse(row.result_json),
      providerOperation:
        operations.results
          .filter((operation) => operation.proposal_id === row.id)
          .map((operation) => ({
            id: operation.id,
            operationId: operation.operation_id,
            version: operation.operation_version,
            status: operation.status,
            output: JSON.parse(operation.result_json),
            updatedAt: operation.updated_at,
          }))[0] ?? null,
      review:
        reviews.results
          .filter((review) => review.proposal_id === row.id)
          .map((review) => ({
            requestHash: review.request_hash,
            expiresAt: review.expires_at,
          }))[0] ?? null,
      externalReference: row.external_reference,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      terminalAt: row.terminal_at,
      ledger: ledger.results
        .filter((entry) => entry.proposal_id === row.id)
        .map((entry) => ({
          sequence: entry.sequence,
          status: entry.status,
          summary: entry.summary,
          externalReference: entry.external_reference,
          createdAt: entry.created_at,
        })),
    })),
  });
};

export const handleRequestActionExecution = async (
  env: Env,
  identity: AgentIdentity,
  proposalId: string,
) => {
  const membership = await selectMembership(env, identity.scope.userId, identity.scope.workspaceId);
  const adminError = requireAdminMembership(membership);
  if (adminError) return adminError;
  const row = await selectProposal(env, identity, proposalId);
  if (!row) return json({ ok: false, error: "Action proposal not found." }, { status: 404 });
  if (row.status !== "proposed")
    return json(
      { ok: false, code: "action_conflict", error: "Only proposed actions can request execution." },
      { status: 409 },
    );
  try {
    await mutationPreflight(env, identity, row);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "mutation_blocked";
    const timestamp = new Date().toISOString();
    await prepareOperatorAlertStatement(env, {
      userId: identity.scope.userId,
      workspaceId: identity.scope.workspaceId,
      agentId: identity.agentId,
      severity: "warning",
      code: "mutation_blocked",
      summary: "A requested external mutation was blocked by authority policy.",
      targetType: "actionProposal",
      targetId: row.id,
      dedupKey: `mutation-blocked:${row.id}:${code}`,
      data: { code, toolId: row.tool_id, packId: row.pack_id },
      timestamp,
    }).run();
    return json(
      {
        ok: false,
        code:
          error && typeof error === "object" && "code" in error ? error.code : "mutation_blocked",
        error: error instanceof Error ? error.message : "Mutation blocked.",
      },
      { status: 403 },
    );
  }
  const policy = await evaluateActionPolicy(env, identity, row, "admin_run");
  if (policy.result.decision === "block" && policy.result.code !== "approval_required") {
    return json(
      { ok: false, code: policy.result.code, error: policy.result.reason },
      { status: policy.result.status },
    );
  }
  const approvalId = createId("cf-approval");
  const intentId = createId("cf-intent");
  const runId = createId("cf-run");
  const timestamp = new Date().toISOString();
  let review: ActionReview;
  try {
    review = await createActionReview(env, identity, row, {
      approvalId,
      runId,
      intentId,
      permission: policy.result.permission,
    });
    await commitActionReviewBatch(env, [
      insertActionReview(env, review, row),
      env.DB.prepare(
        `UPDATE control_action_proposals SET status = 'approval_requested', approval_request_id = ?,
         policy_decision_id = ?, run_id = ?, workflow_intent_id = ?, version = version + 1,
         updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'proposed' AND version = ?`,
      ).bind(
        approvalId,
        policy.decisionId,
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
       VALUES (?, ?, ?, ?, 'act', ?, ?, ?, 'interrupted', ?, ?)`,
      ).bind(
        intentId,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        `action.${row.action_type}`,
        toJson({ mode: "execute" }),
        toJson({ actionProposalId: row.id }),
        timestamp,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO control_runs (id, user_id, workspace_id, agent_id, workflow_intent_id, status,
         execution_json, stage, engine, heartbeat_at, last_event_at, data_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'interrupted', ?, 'act', 'cloudflare', ?, ?, ?, ?, ?)`,
      ).bind(
        runId,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        intentId,
        toJson({ mode: "execute" }),
        timestamp,
        timestamp,
        toJson({
          displayName: row.summary,
          actionProposalId: row.id,
          summary: "Action approval required.",
          agentRevision: identity.agentRevision ?? 0,
          effectTarget: effectTargetOf(identity),
        }),
        timestamp,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO control_approval_requests (id, user_id, workspace_id, agent_id, workflow_intent_id,
         run_id, tool_id, status, reason, data_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', 'External mutation requires approval.', ?, ?, ?)`,
      ).bind(
        approvalId,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        intentId,
        runId,
        row.tool_id,
        toJson({
          actionProposalId: row.id,
          source: "action_authority",
          actionReviewHash: review.request_hash,
          expiresAt: review.expires_at,
        }),
        timestamp,
        timestamp,
      ),
      appendLedgerStatement(env, identity, {
        proposalId: row.id,
        status: "blocked",
        requiredStatus: "approval_requested",
        requiredUpdatedAt: timestamp,
        summary: "Action is waiting for approval.",
        timestamp,
      }),
      ...actionEvidenceStatements(env, identity, {
        proposalId: row.id,
        action: "action.approval_requested",
        eventType: "action.approval.requested",
        summary: "External mutation is waiting for workspace approval.",
        status: "approval_requested",
        timestamp,
        data: { approvalRequestId: approvalId, runId },
      }),
    ]);
  } catch (error) {
    return reviewFailure(error);
  }
  await dispatchActionUpdate(env, identity, {
    approvalRequestId: approvalId,
    proposalId: row.id,
    runId,
    status: "approval_requested",
  });
  await enqueueNotificationEvent(env, identity, {
    type: "action.approval.requested",
    targetType: "actionProposal",
    targetId: row.id,
    data: { approvalRequestId: approvalId, runId },
  });
  return json(
    {
      ok: false,
      code: "approval_required",
      proposalId: row.id,
      approvalRequest: {
        id: approvalId,
        status: "requested",
        requestHash: review.request_hash,
        expiresAt: review.expires_at,
      },
      run: { id: runId, workflowIntentId: intentId, status: "interrupted" },
    },
    { status: 202 },
  );
};

export const approveAndExecuteActionApproval = async (
  env: Env,
  identity: AgentIdentity,
  approval: ControlApprovalRequestRow,
) => {
  const data = parseDataJson(approval.data_json);
  const proposalId = typeof data.actionProposalId === "string" ? data.actionProposalId : "";
  const row = proposalId ? await selectProposal(env, identity, proposalId) : null;
  if (!row || row.status !== "approval_requested" || row.approval_request_id !== approval.id) {
    return json(
      { ok: false, code: "action_conflict", error: "Action approval is no longer active." },
      { status: 409 },
    );
  }
  const timestamp = new Date().toISOString();
  let review: ActionReview;
  try {
    await mutationPreflight(env, identity, row);
    const policy = await evaluateActionPolicy(env, identity, row, "admin_resume");
    if (policy.result.decision === "block")
      return json(
        { ok: false, code: policy.result.code, error: policy.result.reason },
        { status: policy.result.status },
      );
    review = await loadActionReview(env, identity, row);
    await commitActionReviewBatch(env, [
      actionReviewTransition(env, identity, row, review, "approved", timestamp),
      env.DB.prepare(
        `UPDATE control_approval_requests SET status = 'approved', updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'requested'`,
      ).bind(timestamp, approval.id, identity.scope.userId, identity.scope.workspaceId),
      env.DB.prepare(
        `UPDATE control_action_proposals SET status = 'approved', version = version + 1, updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'approval_requested'`,
      ).bind(timestamp, row.id, identity.scope.userId, identity.scope.workspaceId),
      env.DB.prepare(
        `UPDATE control_runs SET status = 'running', heartbeat_at = ?, last_event_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'interrupted'`,
      ).bind(
        timestamp,
        timestamp,
        timestamp,
        approval.run_id,
        identity.scope.userId,
        identity.scope.workspaceId,
      ),
      env.DB.prepare(
        `UPDATE control_workflow_intents SET status = 'running', updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'interrupted'`,
      ).bind(
        timestamp,
        approval.workflow_intent_id,
        identity.scope.userId,
        identity.scope.workspaceId,
      ),
      ...actionEvidenceStatements(env, identity, {
        proposalId: row.id,
        action: "action.approved",
        eventType: "action.approved",
        summary: "External mutation approved by a workspace operator.",
        status: "approved",
        timestamp,
        data: { approvalRequestId: approval.id, runId: approval.run_id },
      }),
    ]);
  } catch (error) {
    return reviewFailure(error);
  }
  let result: Awaited<ReturnType<typeof executeActionProposal>>;
  try {
    result = await executeActionProposal(env, identity, row.id);
  } catch (error) {
    return reviewFailure(error);
  }
  const completedAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE control_runs SET status = ?, completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
         failed_at = CASE WHEN ? = 'failed' THEN ? ELSE failed_at END, last_event_at = ?,
         data_json = json_set(data_json, '$.summary', ?, '$.actionProposalId', ?), updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'running'`,
    ).bind(
      result.status === "executed" || result.status === "reconciled" ? "completed" : "failed",
      result.status === "executed" || result.status === "reconciled" ? "completed" : "failed",
      completedAt,
      result.status === "executed" || result.status === "reconciled" ? "completed" : "failed",
      completedAt,
      completedAt,
      result.summary,
      row.id,
      completedAt,
      approval.run_id,
      identity.scope.userId,
      identity.scope.workspaceId,
    ),
    env.DB.prepare(
      `UPDATE control_workflow_intents SET status = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'running'`,
    ).bind(
      result.status === "executed" || result.status === "reconciled" ? "completed" : "failed",
      completedAt,
      approval.workflow_intent_id,
      identity.scope.userId,
      identity.scope.workspaceId,
    ),
  ]);
  await dispatchActionUpdate(env, identity, {
    approvalRequestId: approval.id,
    proposalId: row.id,
    runId: approval.run_id,
    status: result.status,
  });
  return json(
    {
      ok: result.status === "executed" || result.status === "reconciled",
      result,
      approvalRequest: { id: approval.id, status: "approved" },
    },
    { status: result.status === "executed" || result.status === "reconciled" ? 200 : 502 },
  );
};

export const cancelActionForDeniedApproval = async (
  env: Env,
  identity: AgentIdentity,
  approval: ControlApprovalRequestRow,
  reason: string,
) => {
  const data = parseDataJson(approval.data_json);
  const proposalId = typeof data.actionProposalId === "string" ? data.actionProposalId : "";
  if (!proposalId) return;
  const timestamp = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE control_action_proposals SET status = 'cancelled', error_json = ?, version = version + 1,
         terminal_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND workspace_id = ?
         AND status = 'approval_requested'`,
    ).bind(
      toJson({ code: "approval_denied", summary: reason }),
      timestamp,
      timestamp,
      proposalId,
      identity.scope.userId,
      identity.scope.workspaceId,
    ),
    appendLedgerStatement(env, identity, {
      proposalId,
      status: "cancelled",
      requiredStatus: "cancelled",
      requiredUpdatedAt: timestamp,
      summary: reason,
      timestamp,
    }),
    ...actionEvidenceStatements(env, identity, {
      proposalId,
      action: "action.cancelled",
      eventType: "action.cancelled",
      summary: reason,
      status: "cancelled",
      timestamp,
      data: { approvalRequestId: approval.id, reason: "approval_denied" },
    }),
  ]);
  await dispatchActionUpdate(env, identity, {
    approvalRequestId: approval.id,
    proposalId,
    runId: approval.run_id,
    status: "cancelled",
  });
};

export const handleReconcileAction = async (
  env: Env,
  identity: AgentIdentity,
  proposalId: string,
) => {
  try {
    const result = await reconcileActionProposal(env, identity, proposalId);
    const resolved = result.status === "reconciled" || result.status === "executed";
    await dispatchActionUpdate(env, identity, { proposalId, status: result.status });
    return json({ ok: resolved, result }, { status: resolved ? 200 : 202 });
  } catch (error) {
    return json(
      {
        ok: false,
        code:
          error && typeof error === "object" && "code" in error
            ? error.code
            : "reconciliation_failed",
        error: error instanceof Error ? error.message : "Reconciliation failed.",
      },
      { status: 409 },
    );
  }
};

export const handleListKillSwitches = async (env: Env, identity: AgentIdentity) => {
  const rows = await env.DB.prepare(
    `SELECT id, scope_kind, scope_id, enabled, reason, created_by_user_id, version, created_at, updated_at
     FROM control_kill_switches WHERE user_id = ? AND workspace_id = ? ORDER BY updated_at DESC`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId)
    .all<Record<string, unknown>>();
  return json({ ok: true, killSwitches: rows.results });
};

export const handleUpdateKillSwitch = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
) => {
  const membership = await selectMembership(env, identity.scope.userId, identity.scope.workspaceId);
  const adminError = requireAdminMembership(membership);
  if (adminError) return adminError;
  const body = await request.json().catch(() => null);
  if (
    !isRecord(body) ||
    !["workspace", "pack", "tool", "connection"].includes(String(body.scopeKind)) ||
    typeof body.scopeId !== "string" ||
    !body.scopeId.trim() ||
    typeof body.enabled !== "boolean" ||
    typeof body.reason !== "string" ||
    !body.reason.trim()
  ) {
    return json({ ok: false, error: "Invalid kill-switch payload." }, { status: 400 });
  }
  const timestamp = new Date().toISOString();
  const id = createId("cf-kill-switch");
  const affected = body.enabled
    ? await env.DB.prepare(
        `SELECT id, approval_request_id, run_id, workflow_intent_id
         FROM control_action_proposals WHERE user_id = ? AND workspace_id = ?
           AND status IN ('proposed', 'approval_requested', 'approved') AND (
             ? = 'workspace' OR (? = 'pack' AND pack_id = ?) OR (? = 'tool' AND tool_id = ?)
             OR (? = 'connection' AND (
               connection_record_id = ? OR connection_record_id IN (
                 SELECT id FROM control_connections
                 WHERE user_id = ? AND workspace_id = ? AND connection_id = ?
               )
             ))
           )`,
      )
        .bind(
          identity.scope.userId,
          identity.scope.workspaceId,
          body.scopeKind,
          body.scopeKind,
          body.scopeId,
          body.scopeKind,
          body.scopeId,
          body.scopeKind,
          body.scopeId,
          identity.scope.userId,
          identity.scope.workspaceId,
          body.scopeId,
        )
        .all<{
          id: string;
          approval_request_id: string | null;
          run_id: string;
          workflow_intent_id: string;
        }>()
    : { results: [] };
  const statements = [
    env.DB.prepare(
      `INSERT INTO control_kill_switches (id, user_id, workspace_id, scope_kind, scope_id, enabled,
         reason, created_by_user_id, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(user_id, workspace_id, scope_kind, scope_id) DO UPDATE SET
         enabled = excluded.enabled, reason = excluded.reason, created_by_user_id = excluded.created_by_user_id,
         version = control_kill_switches.version + 1, updated_at = excluded.updated_at`,
    ).bind(
      id,
      identity.scope.userId,
      identity.scope.workspaceId,
      body.scopeKind,
      body.scopeId.trim(),
      body.enabled ? 1 : 0,
      body.reason.trim().slice(0, 240),
      identity.scope.userId,
      timestamp,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO control_audit_events (
         id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
       ) VALUES (?, ?, ?, 'action.kill_switch.updated', ?, 'killSwitch', ?, ?, ?)`,
    ).bind(
      createId("cf-audit"),
      identity.scope.userId,
      identity.scope.workspaceId,
      body.reason.trim().slice(0, 240),
      `${body.scopeKind}:${body.scopeId}`,
      toJson({ scopeKind: body.scopeKind, scopeId: body.scopeId, enabled: body.enabled }),
      timestamp,
    ),
  ];
  for (const proposal of affected.results) {
    statements.push(
      env.DB.prepare(
        `UPDATE control_action_proposals SET status = 'cancelled', error_json = ?, terminal_at = ?,
           version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND workspace_id = ?
           AND status IN ('proposed', 'approval_requested', 'approved')`,
      ).bind(
        toJson({ code: "kill_switch_active" }),
        timestamp,
        timestamp,
        proposal.id,
        identity.scope.userId,
        identity.scope.workspaceId,
      ),
      appendLedgerStatement(env, identity, {
        proposalId: proposal.id,
        status: "cancelled",
        requiredStatus: "cancelled",
        requiredUpdatedAt: timestamp,
        summary: "Action cancelled by an operator kill switch.",
        data: { scopeKind: body.scopeKind, scopeId: body.scopeId },
        timestamp,
      }),
    );
    if (proposal.approval_request_id) {
      statements.push(
        env.DB.prepare(
          `UPDATE control_approval_requests SET status = 'cancelled', updated_at = ?
           WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'requested'`,
        ).bind(
          timestamp,
          proposal.approval_request_id,
          identity.scope.userId,
          identity.scope.workspaceId,
        ),
        env.DB.prepare(
          `UPDATE control_runs SET status = 'cancelled', cancelled_at = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'interrupted'`,
        ).bind(
          timestamp,
          timestamp,
          proposal.run_id,
          identity.scope.userId,
          identity.scope.workspaceId,
        ),
        env.DB.prepare(
          `UPDATE control_workflow_intents SET status = 'cancelled', updated_at = ?
           WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'interrupted'`,
        ).bind(
          timestamp,
          proposal.workflow_intent_id,
          identity.scope.userId,
          identity.scope.workspaceId,
        ),
      );
    }
  }
  await env.DB.batch(statements);
  return json({
    ok: true,
    killSwitch: {
      scopeKind: body.scopeKind,
      scopeId: body.scopeId,
      enabled: body.enabled,
      reason: body.reason,
    },
  });
};
