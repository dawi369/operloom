import { assertSchemaValue } from "@operloom/agent-sdk/control-plane";

import { selectAgent, selectMembership } from "./authz-store";
import { isRecord, json, parseDataJson, parseJson } from "./http";
import { isAdminMembership } from "./membership-policy";
import { buildControlRunRelation } from "./run-relations";
import { executeResolvedRuntimeAdminTool } from "./runtime-admin-execution";
import { resolveRuntimeToolForAgent } from "./runtime-tool-catalog";
import { dispatchWorkbenchSessionEvent } from "./session-coordinator";
import { evaluateToolPolicy, recordToolPolicyDecision, toolPolicyError } from "./tool-policy";
import { approveAndExecuteActionApproval, cancelActionForDeniedApproval } from "./action-authority";
import { enqueueNotificationEvent } from "./notification-delivery";
import {
  createId,
  toJson,
  type AgentIdentity,
  type ControlApprovalRequestRow,
  type Env,
} from "./types";

const error = (code: string, message: string) => ({
  code,
  message,
  retryable: false,
  redacted: true as const,
});

const readApproval = (env: Env, identity: AgentIdentity, id: string) =>
  env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, workflow_intent_id, run_id, tool_id, status,
            reason, data_json, created_at, updated_at
     FROM control_approval_requests
     WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ? LIMIT 1`,
  )
    .bind(id, identity.scope.userId, identity.scope.workspaceId, identity.agentId)
    .first<ControlApprovalRequestRow>();

const approvalBody = (row: ControlApprovalRequestRow, status = row.status) => ({
  id: row.id,
  agentId: row.agent_id,
  workflowIntentId: row.workflow_intent_id,
  runId: row.run_id,
  toolId: row.tool_id,
  status,
  reason: row.reason,
  data: parseDataJson(row.data_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const requireAdmin = async (env: Env, identity: AgentIdentity) => {
  const membership = await selectMembership(env, identity.scope.userId, identity.scope.workspaceId);
  return membership?.status === "active" && isAdminMembership(membership) ? membership : null;
};

export const createRuntimeToolApproval = async (input: {
  env: Env;
  identity: AgentIdentity;
  toolName: string;
  toolInput: Record<string, unknown>;
  policyDecisionId: string;
  policyReference: string;
  reason: string;
  packId: string;
  packVersion: string;
  runtimeVersion: string;
  bindingVersion: number;
  transport: string;
}) => {
  const timestamp = new Date().toISOString();
  const workflowIntentId = createId("cf-intent");
  const runId = createId("cf-run");
  const approvalRequestId = createId("cf-approval");
  const execution = { mode: "dry_run", policy: input.policyReference };
  const payload = {
    toolName: input.toolName,
    input: input.toolInput,
    packId: input.packId,
    packVersion: input.packVersion,
    runtimeVersion: input.runtimeVersion,
    bindingVersion: input.bindingVersion,
    transport: input.transport,
    policyDecisionId: input.policyDecisionId,
    source: "admin",
  };
  const guard = `SELECT 1 FROM control_runs WHERE id = ? AND user_id = ? AND workspace_id = ?
    AND agent_id = ? AND status = 'interrupted' AND updated_at = ?`;
  await input.env.DB.batch([
    input.env.DB.prepare(
      `INSERT INTO control_workflow_intents (
         id, user_id, workspace_id, agent_id, stage, type, execution_json, payload_json,
         status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'observe', ?, ?, ?, 'interrupted', ?, ?)`,
    ).bind(
      workflowIntentId,
      input.identity.scope.userId,
      input.identity.scope.workspaceId,
      input.identity.agentId,
      `tool.${input.toolName}`,
      toJson(execution),
      toJson(payload),
      timestamp,
      timestamp,
    ),
    input.env.DB.prepare(
      `INSERT INTO control_runs (
         id, user_id, workspace_id, agent_id, workflow_intent_id, status, execution_json,
         stage, engine, heartbeat_at, last_event_at, data_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'interrupted', ?, 'observe', 'cloudflare', ?, ?, ?, ?, ?)`,
    ).bind(
      runId,
      input.identity.scope.userId,
      input.identity.scope.workspaceId,
      input.identity.agentId,
      workflowIntentId,
      toJson(execution),
      timestamp,
      timestamp,
      toJson({
        displayName: input.toolName,
        summary: input.reason,
        approvalRequestId,
        ...payload,
      }),
      timestamp,
      timestamp,
    ),
    input.env.DB.prepare(
      `INSERT INTO control_approval_requests (
         id, user_id, workspace_id, agent_id, workflow_intent_id, run_id, tool_id, status,
         reason, data_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?)`,
    ).bind(
      approvalRequestId,
      input.identity.scope.userId,
      input.identity.scope.workspaceId,
      input.identity.agentId,
      workflowIntentId,
      runId,
      input.toolName,
      input.reason,
      toJson(payload),
      timestamp,
      timestamp,
    ),
    ...[
      ["run.interrupted", "run", runId],
      ["approval.requested", "approvalRequest", approvalRequestId],
    ].flatMap(([action, targetType, targetId]) => [
      input.env.DB.prepare(
        `INSERT INTO control_audit_events (
           id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${guard})`,
      ).bind(
        createId("cf-audit"),
        input.identity.scope.userId,
        input.identity.scope.workspaceId,
        action,
        input.reason,
        targetType,
        targetId,
        toJson({ runId, workflowIntentId, toolName: input.toolName, approvalRequestId }),
        timestamp,
        runId,
        input.identity.scope.userId,
        input.identity.scope.workspaceId,
        input.identity.agentId,
        timestamp,
      ),
      input.env.DB.prepare(
        `INSERT INTO control_plane_events (
           id, user_id, workspace_id, agent_id, type, summary, target_type, target_id,
           data_json, created_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${guard})`,
      ).bind(
        createId("cf-event"),
        input.identity.scope.userId,
        input.identity.scope.workspaceId,
        input.identity.agentId,
        action,
        input.reason,
        targetType,
        targetId,
        toJson({ runId, workflowIntentId, toolName: input.toolName, approvalRequestId }),
        timestamp,
        runId,
        input.identity.scope.userId,
        input.identity.scope.workspaceId,
        input.identity.agentId,
        timestamp,
      ),
    ]),
  ]);
  await dispatchWorkbenchSessionEvent(input.env, input.identity, {
    type: "approval.updated",
    data: {
      approvalRequestId,
      status: "requested",
      runId,
      workflowIntentId,
      toolName: input.toolName,
    },
  });
  await enqueueNotificationEvent(input.env, input.identity, {
    type: "approval.requested",
    targetType: "approvalRequest",
    targetId: approvalRequestId,
    data: { runId },
  });
  return json(
    {
      ok: false,
      run: { id: runId, workflowIntentId, status: "interrupted", execution },
      approvalRequest: { id: approvalRequestId, status: "requested", reason: input.reason },
      error: input.reason,
      details: error("approval_required", input.reason),
      policyDecisionId: input.policyDecisionId,
    },
    { status: 403 },
  );
};

export const approveApprovalAndResumeRun = async (
  env: Env,
  identity: AgentIdentity,
  approval: ControlApprovalRequestRow,
  policyDecisionId: string,
) => {
  const timestamp = new Date().toISOString();
  const data = parseDataJson(approval.data_json);
  const guard = `SELECT 1 FROM control_runs WHERE id = ? AND user_id = ? AND workspace_id = ?
    AND status = 'running' AND updated_at = ?`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE control_approval_requests SET status = 'approved', data_json = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'requested'
         AND EXISTS (SELECT 1 FROM control_runs WHERE id = ? AND user_id = ? AND workspace_id = ?
           AND agent_id = ? AND status = 'interrupted')`,
    ).bind(
      toJson({
        ...data,
        decidedByUserId: identity.scope.userId,
        policyDecisionId,
        decidedAt: timestamp,
      }),
      timestamp,
      approval.id,
      identity.scope.userId,
      identity.scope.workspaceId,
      approval.run_id,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
    ),
    env.DB.prepare(
      `UPDATE control_workflow_intents SET status = 'running', updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?
         AND EXISTS (SELECT 1 FROM control_runs WHERE id = ? AND user_id = ? AND workspace_id = ?
           AND agent_id = ? AND status = 'interrupted')`,
    ).bind(
      timestamp,
      approval.workflow_intent_id,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      approval.run_id,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
    ),
    env.DB.prepare(
      `UPDATE control_runs SET status = 'running', heartbeat_at = ?, last_event_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?
         AND status = 'interrupted'`,
    ).bind(
      timestamp,
      timestamp,
      timestamp,
      approval.run_id,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
    ),
    ...[
      ["approval.approved", "approvalRequest", approval.id],
      ["run.resumed", "run", approval.run_id],
    ].flatMap(([action, targetType, targetId]) => [
      env.DB.prepare(
        `INSERT INTO control_audit_events (
           id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${guard})`,
      ).bind(
        createId("cf-audit"),
        identity.scope.userId,
        identity.scope.workspaceId,
        action,
        `Approved ${approval.tool_id} execution.`,
        targetType,
        targetId,
        toJson({
          runId: approval.run_id,
          workflowIntentId: approval.workflow_intent_id,
          toolName: approval.tool_id,
          policyDecisionId,
        }),
        timestamp,
        approval.run_id,
        identity.scope.userId,
        identity.scope.workspaceId,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO control_plane_events (
           id, user_id, workspace_id, agent_id, type, summary, target_type, target_id,
           data_json, created_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${guard})`,
      ).bind(
        createId("cf-event"),
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        action,
        `Approved ${approval.tool_id} execution.`,
        targetType,
        targetId,
        toJson({
          runId: approval.run_id,
          workflowIntentId: approval.workflow_intent_id,
          toolName: approval.tool_id,
          policyDecisionId,
        }),
        timestamp,
        approval.run_id,
        identity.scope.userId,
        identity.scope.workspaceId,
        timestamp,
      ),
    ]),
  ]);
  return results[2]?.meta?.changes !== 0;
};

export const denyApprovalAndCancelRun = async (
  env: Env,
  identity: AgentIdentity,
  approval: ControlApprovalRequestRow,
  denyReason: string,
) => {
  const timestamp = new Date().toISOString();
  const data = parseDataJson(approval.data_json);
  const guard = `SELECT 1 FROM control_runs WHERE id = ? AND user_id = ? AND workspace_id = ?
    AND status = 'cancelled' AND updated_at = ?`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE control_approval_requests SET status = 'denied', data_json = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'requested'
         AND EXISTS (SELECT 1 FROM control_runs WHERE id = ? AND user_id = ? AND workspace_id = ?
           AND agent_id = ? AND status = 'interrupted')`,
    ).bind(
      toJson({ ...data, decidedByUserId: identity.scope.userId, denyReason, decidedAt: timestamp }),
      timestamp,
      approval.id,
      identity.scope.userId,
      identity.scope.workspaceId,
      approval.run_id,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
    ),
    env.DB.prepare(
      `UPDATE control_workflow_intents SET status = 'cancelled', updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?
         AND EXISTS (SELECT 1 FROM control_runs WHERE id = ? AND user_id = ? AND workspace_id = ?
           AND agent_id = ? AND status = 'interrupted')`,
    ).bind(
      timestamp,
      approval.workflow_intent_id,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      approval.run_id,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
    ),
    env.DB.prepare(
      `UPDATE control_runs SET status = 'cancelled', heartbeat_at = ?, last_event_at = ?,
         cancelled_at = ?, data_json = json_set(data_json, '$.summary', ?), updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?
         AND status = 'interrupted'`,
    ).bind(
      timestamp,
      timestamp,
      timestamp,
      denyReason,
      timestamp,
      approval.run_id,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
    ),
    ...[
      ["approval.denied", "approvalRequest", approval.id],
      ["run.cancelled", "run", approval.run_id],
    ].flatMap(([action, targetType, targetId]) => [
      env.DB.prepare(
        `INSERT INTO control_audit_events (
           id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${guard})`,
      ).bind(
        createId("cf-audit"),
        identity.scope.userId,
        identity.scope.workspaceId,
        action,
        denyReason,
        targetType,
        targetId,
        toJson({ runId: approval.run_id, toolName: approval.tool_id }),
        timestamp,
        approval.run_id,
        identity.scope.userId,
        identity.scope.workspaceId,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO control_plane_events (
           id, user_id, workspace_id, agent_id, type, summary, target_type, target_id,
           data_json, created_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${guard})`,
      ).bind(
        createId("cf-event"),
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        action,
        denyReason,
        targetType,
        targetId,
        toJson({ runId: approval.run_id, toolName: approval.tool_id }),
        timestamp,
        approval.run_id,
        identity.scope.userId,
        identity.scope.workspaceId,
        timestamp,
      ),
    ]),
  ]);
  return results[2]?.meta?.changes !== 0;
};

export const handleListToolApprovals = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
) => {
  if (!(await requireAdmin(env, identity))) {
    return json(
      {
        ok: false,
        error: "Admin membership required",
        details: error("admin_required", "Workspace owner/admin membership is required."),
      },
      { status: 403 },
    );
  }
  const url = new URL(request.url);
  const status = ["requested", "decided", "all"].includes(url.searchParams.get("status") ?? "")
    ? url.searchParams.get("status")!
    : "all";
  const requested = Number(url.searchParams.get("limit") ?? 20);
  const limit = Math.max(1, Math.min(50, Number.isFinite(requested) ? requested : 20));
  const rows = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, workflow_intent_id, run_id, tool_id, status,
            reason, data_json, created_at, updated_at FROM control_approval_requests
     WHERE user_id = ? AND workspace_id = ? AND agent_id = ?
       AND (? = 'all' OR (? = 'requested' AND status = 'requested') OR
         (? = 'decided' AND status <> 'requested'))
     ORDER BY CASE WHEN status = 'requested' THEN 0 ELSE 1 END, updated_at DESC LIMIT ?`,
  )
    .bind(
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      status,
      status,
      status,
      limit,
    )
    .all<ControlApprovalRequestRow>();
  return json({ ok: true, status, approvals: rows.results.map((row) => approvalBody(row)) });
};

export const handleApproveToolApproval = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
  approvalRequestId: string,
) => {
  const membership = await requireAdmin(env, identity);
  if (!membership)
    return json(
      {
        ok: false,
        error: "Admin membership required",
        details: error("admin_required", "Workspace owner/admin membership is required."),
      },
      { status: 403 },
    );
  const approval = await readApproval(env, identity, approvalRequestId);
  if (!approval)
    return json(
      {
        ok: false,
        error: "Approval request not found",
        details: error("approval_not_found", "Approval request was not found."),
      },
      { status: 404 },
    );
  if (approval.status !== "requested")
    return json(
      {
        ok: false,
        error: "Approval request is already decided",
        approvalRequest: approvalBody(approval),
        details: error("approval_already_decided", "Only requested approvals can be approved."),
      },
      { status: 409 },
    );
  const approvalData = parseDataJson(approval.data_json);
  if (typeof approvalData.actionProposalId === "string") {
    return approveAndExecuteActionApproval(env, identity, approval);
  }
  const agent = await selectAgent(env, identity.agentId, identity.scope.workspaceId);
  const resolved = agent ? resolveRuntimeToolForAgent(agent, approval.tool_id) : undefined;
  if (!resolved)
    return json(
      {
        ok: false,
        error: "Runtime tool unavailable",
        details: error("runtime_incompatible", "The approval runtime is no longer compatible."),
      },
      { status: 409 },
    );
  const data = parseDataJson(approval.data_json);
  const toolInput = isRecord(data.input) ? data.input : {};
  try {
    assertSchemaValue(resolved.binding.inputSchema, toolInput, `${approval.tool_id} input`);
  } catch (cause) {
    return json(
      {
        ok: false,
        error: cause instanceof Error ? cause.message : "Invalid approval input",
        details: error("invalid_input", "Stored approval input is invalid."),
      },
      { status: 400 },
    );
  }
  const policy = await evaluateToolPolicy(env, identity, {
    membership,
    toolName: approval.tool_id,
    executionMode: "dry_run",
    surface: "admin_resume",
  });
  const policyDecisionId = await recordToolPolicyDecision(env, identity, {
    toolName: approval.tool_id,
    surface: "admin_resume",
    result: policy,
    data: { action: "approval.approve", approvalRequestId: approval.id },
  });
  if (policy.decision === "block")
    return json(
      { ok: false, error: policy.reason, details: toolPolicyError(policy), policyDecisionId },
      { status: policy.status },
    );
  if (!(await approveApprovalAndResumeRun(env, identity, approval, policyDecisionId))) {
    return json(
      {
        ok: false,
        error: "Run is already terminal",
        details: error("run_terminal", "Publication authority was revoked."),
      },
      { status: 409 },
    );
  }
  const relation = buildControlRunRelation({ runId: approval.run_id });
  if (!relation.ok) throw new Error(relation.reason);
  const response = await executeResolvedRuntimeAdminTool({
    requestUrl: request.url,
    env,
    identity,
    resolved,
    toolInput,
    policyDecisionId,
    started: {
      runId: approval.run_id,
      workflowIntentId: approval.workflow_intent_id,
      relation: relation.relation,
    },
  });
  const body = (await response.json()) as Record<string, unknown>;
  return json(
    { ...body, approvalRequest: approvalBody(approval, "approved") },
    { status: response.status === 201 ? 200 : response.status },
  );
};

export const handleDenyToolApproval = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
  approvalRequestId: string,
) => {
  if (!(await requireAdmin(env, identity)))
    return json(
      {
        ok: false,
        error: "Admin membership required",
        details: error("admin_required", "Workspace owner/admin membership is required."),
      },
      { status: 403 },
    );
  const approval = await readApproval(env, identity, approvalRequestId);
  if (!approval)
    return json(
      {
        ok: false,
        error: "Approval request not found",
        details: error("approval_not_found", "Approval request was not found."),
      },
      { status: 404 },
    );
  if (approval.status !== "requested")
    return json(
      {
        ok: false,
        error: "Approval request is already decided",
        approvalRequest: approvalBody(approval),
        details: error("approval_already_decided", "Only requested approvals can be denied."),
      },
      { status: 409 },
    );
  const body = parseJson(await request.text());
  const reason =
    isRecord(body) && typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, 240)
      : "Approval denied by workspace admin.";
  if (!(await denyApprovalAndCancelRun(env, identity, approval, reason))) {
    return json(
      {
        ok: false,
        error: "Approval run is already terminal",
        details: error("run_terminal", "The approval can no longer change a terminal run."),
      },
      { status: 409 },
    );
  }
  await cancelActionForDeniedApproval(env, identity, approval, reason);
  await dispatchWorkbenchSessionEvent(env, identity, {
    type: "approval.updated",
    data: {
      approvalRequestId: approval.id,
      status: "denied",
      runId: approval.run_id,
      workflowIntentId: approval.workflow_intent_id,
      toolName: approval.tool_id,
    },
  });
  return json({
    ok: true,
    run: {
      id: approval.run_id,
      workflowIntentId: approval.workflow_intent_id,
      status: "cancelled",
    },
    approvalRequest: approvalBody(approval, "denied"),
    toolCall: null,
    artifact: null,
  });
};
