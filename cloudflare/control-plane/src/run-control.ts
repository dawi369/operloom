import { selectMembership } from "./authz-store";
import { appendControlPlaneEvent } from "./control-plane-events";
import { appendControlAudit } from "./control-run-store";
import { json, parseDataJson } from "./http";
import { requireActiveMembership } from "./membership-policy";
import {
  executeRuntimeWorkflow,
  type RuntimeWorkflowExecutor as RetryWorkflowHandler,
} from "./pack-workflow-runtime";
import { dispatchWorkbenchSessionEvent } from "./session-coordinator";
import { activeRunStatusSql, activeRunStatuses, isTerminalRunStatus } from "./run-transitions";
import { packWorkflowBindings, type PackWorkflowType } from "../../../lib/agent-runtime/registry";
import { toJson, type AgentIdentity, type ControlRunRow, type Env } from "./types";

type ControllableRunRow = ControlRunRow & {
  workflow_type: string | null;
  payload_json: string | null;
};

export type RunRetryHandlers = Partial<Record<PackWorkflowType, RetryWorkflowHandler>>;

const selectControllableRun = (env: Env, identity: AgentIdentity, runId: string) =>
  env.DB.prepare(
    `SELECT r.id, r.user_id, r.workspace_id, r.agent_id, r.workflow_intent_id, r.status,
            r.execution_json, r.stage, r.engine, r.heartbeat_at, r.last_event_at,
            r.completed_at, r.failed_at, r.cancelled_at, r.data_json, r.created_at, r.updated_at,
            i.type AS workflow_type, i.payload_json
     FROM control_runs r
     LEFT JOIN control_workflow_intents i
       ON i.user_id = r.user_id
      AND i.workspace_id = r.workspace_id
      AND i.id = r.workflow_intent_id
     WHERE r.user_id = ? AND r.workspace_id = ? AND r.id = ?
     LIMIT 1`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, runId)
    .first<ControllableRunRow>();

const requireRunMember = async (env: Env, identity: AgentIdentity) => {
  const membership = await selectMembership(env, identity.scope.userId, identity.scope.workspaceId);
  return requireActiveMembership(membership);
};

export const handleCancelExecutionRun = async (
  env: Env,
  identity: AgentIdentity,
  runId: string,
) => {
  const membershipError = await requireRunMember(env, identity);
  if (membershipError) return membershipError;

  const run = await selectControllableRun(env, identity, runId);
  if (!run) return json({ ok: false, error: "Run not found" }, { status: 404 });
  if (!activeRunStatuses.includes(run.status as (typeof activeRunStatuses)[number])) {
    return json(
      { ok: false, error: "Run cannot be cancelled in its current state" },
      { status: 409 },
    );
  }

  const timestamp = new Date().toISOString();
  const data = parseDataJson(run.data_json);
  const workflowBinding = run.workflow_type
    ? packWorkflowBindings[run.workflow_type as PackWorkflowType]
    : undefined;
  const [cancelResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE control_runs
       SET status = 'cancelled', last_event_at = ?, cancelled_at = ?, data_json = ?, updated_at = ?
       WHERE user_id = ? AND workspace_id = ? AND id = ?
         AND status IN ${activeRunStatusSql}`,
    ).bind(
      timestamp,
      timestamp,
      toJson({
        ...data,
        summary: "Cancelled by the user.",
        cancelledByUserId: identity.scope.userId,
        physicalCancellation: workflowBinding?.cancellation.physicalAbort ?? "unsupported",
      }),
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      run.id,
    ),
    env.DB.prepare(
      `UPDATE control_workflow_intents
       SET status = 'cancelled', updated_at = ?
       WHERE user_id = ? AND workspace_id = ? AND id = ?
         AND status IN ('queued', 'running', 'waiting', 'interrupted')
         AND EXISTS (
           SELECT 1 FROM control_runs
           WHERE user_id = ? AND workspace_id = ? AND id = ? AND status = 'cancelled'
         )`,
    ).bind(
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      run.workflow_intent_id,
      identity.scope.userId,
      identity.scope.workspaceId,
      run.id,
    ),
    env.DB.prepare(
      `UPDATE control_tool_calls
       SET status = 'cancelled', finished_at = ?
       WHERE user_id = ? AND workspace_id = ? AND run_id = ? AND status = 'running'
         AND EXISTS (
           SELECT 1 FROM control_runs
           WHERE user_id = ? AND workspace_id = ? AND id = ? AND status = 'cancelled'
         )`,
    ).bind(
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      run.id,
      identity.scope.userId,
      identity.scope.workspaceId,
      run.id,
    ),
    env.DB.prepare(
      `UPDATE control_trigger_dispatches
       SET status = 'cancelled', heartbeat_at = ?, lease_owner = NULL, lease_expires_at = NULL,
           error_json = ?, updated_at = ?
       WHERE user_id = ? AND workspace_id = ? AND agent_id = ? AND run_id = ?
         AND status IN ('leased', 'running')
         AND EXISTS (
           SELECT 1 FROM control_runs
           WHERE user_id = ? AND workspace_id = ? AND id = ? AND status = 'cancelled'
         )`,
    ).bind(
      timestamp,
      toJson({ code: "run_cancelled", message: "Run was cancelled by the user." }),
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      run.agent_id,
      run.id,
      identity.scope.userId,
      identity.scope.workspaceId,
      run.id,
    ),
    env.DB.prepare(
      `DELETE FROM control_artifacts
       WHERE user_id = ? AND workspace_id = ? AND id LIKE ?
         AND json_extract(data_json, '$.publicationStatus') = 'staged'
         AND EXISTS (
           SELECT 1 FROM control_runs
           WHERE user_id = ? AND workspace_id = ? AND id = ? AND status = 'cancelled'
         )`,
    ).bind(
      identity.scope.userId,
      identity.scope.workspaceId,
      `${run.id}-%`,
      identity.scope.userId,
      identity.scope.workspaceId,
      run.id,
    ),
  ]);
  if (cancelResult.meta?.changes === 0) {
    return json(
      { ok: false, error: "Run cannot be cancelled in its current state" },
      { status: 409 },
    );
  }

  const summary = "Cancelled run.";
  await appendControlAudit(env, {
    ...identity,
    runId: run.id,
    workflowIntentId: run.workflow_intent_id,
    action: "run.cancelled",
    summary,
    targetType: "run",
    targetId: run.id,
  });
  await appendControlPlaneEvent(env, identity, {
    type: "run.cancelled",
    summary,
    targetType: "run",
    targetId: run.id,
    data: { runId: run.id, workflowIntentId: run.workflow_intent_id },
  });
  await dispatchWorkbenchSessionEvent(env, identity, {
    type: "workflow.run.updated",
    data: { runId: run.id, workflowIntentId: run.workflow_intent_id, status: "cancelled" },
  });

  return json({
    ok: true,
    run: {
      id: run.id,
      status: "cancelled",
      physicalCancellation: workflowBinding?.cancellation.physicalAbort ?? "unsupported",
    },
  });
};

export const handleRetryExecutionRun = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
  runId: string,
  handlers?: RunRetryHandlers,
) => {
  const membershipError = await requireRunMember(env, identity);
  if (membershipError) return membershipError;

  const run = await selectControllableRun(env, identity, runId);
  if (!run) return json({ ok: false, error: "Run not found" }, { status: 404 });
  if (!isTerminalRunStatus(run.status) || run.status === "completed") {
    return json(
      { ok: false, error: "Only failed, blocked or cancelled runs can be retried" },
      { status: 409 },
    );
  }

  const payload = run.payload_json ? parseDataJson(run.payload_json) : {};
  const retryRequest = new Request(request.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: payload.input ?? payload,
      executionMode: "dry_run",
    }),
  });
  const retryIdentity = { ...identity, agentId: run.agent_id };
  const retryHandler = handlers?.[run.workflow_type as PackWorkflowType];
  const response = run.workflow_type
    ? retryHandler
      ? await retryHandler(retryRequest, env, retryIdentity, { source: "user" })
      : await executeRuntimeWorkflow(run.workflow_type, retryRequest, env, retryIdentity, {
          source: "user",
        })
    : null;
  if (!response) {
    return json({ ok: false, error: "This run type does not support retry" }, { status: 409 });
  }

  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as {
    run?: { runId?: string; id?: string; workflowIntentId?: string };
  } | null;
  const retriedRunId = body?.run?.runId ?? body?.run?.id;
  if (retriedRunId) {
    await env.DB.prepare(
      `UPDATE control_runs
       SET data_json = json_set(data_json, '$.retryOfRunId', ?)
       WHERE user_id = ? AND workspace_id = ? AND id = ?`,
    )
      .bind(run.id, identity.scope.userId, identity.scope.workspaceId, retriedRunId)
      .run();
    await appendControlAudit(env, {
      ...identity,
      runId: retriedRunId,
      workflowIntentId: body?.run?.workflowIntentId ?? "",
      action: "run.retried",
      summary: `Retried ${run.id}.`,
      targetType: "run",
      targetId: retriedRunId,
      data: { retryOfRunId: run.id },
    });
  }
  return response;
};
