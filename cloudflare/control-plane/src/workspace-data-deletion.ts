import { selectWorkspace } from "./authz-store";
import { revokeWorkspaceConnections } from "./connection-broker";
import { revokeWorkspaceDevices } from "./notification-delivery";
import { retainedDataEnabled } from "./feature-gates";
import { isRecord, json, parseDataJson } from "./http";
import { prepareOperatorAlertStatement } from "./operator-alerts";
import { createId, toJson, type AgentIdentity, type ControlArtifactRow, type Env } from "./types";
import {
  deletionRecoveryMs,
  lifecycleFaultInjectionEnabled,
  loadCollections,
  reauthenticationMaxAgeMs,
  requireLifecycleAdmin,
  requireLifecycleOwner,
} from "./workspace-data-export";

export const handleRequestWorkspaceDeletion = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
) => {
  if (!retainedDataEnabled(env))
    return json(
      {
        ok: false,
        code: "retained_data_disabled",
        error: "Retained-data operations are disabled.",
      },
      { status: 503 },
    );
  const ownerError = await requireLifecycleOwner(env, identity);
  if (ownerError) return ownerError;
  const workspace = await selectWorkspace(env, identity.scope.workspaceId);
  if (!workspace) return json({ ok: false, error: "Workspace not found." }, { status: 404 });
  if (workspace.status !== "active")
    return json(
      { ok: false, code: "workspace_not_active", error: "Workspace is not active." },
      { status: 409 },
    );
  const activeExport = await env.DB.prepare(
    `SELECT id FROM control_data_jobs
     WHERE workspace_id = ? AND kind = 'export' AND status IN ('queued', 'running') LIMIT 1`,
  )
    .bind(identity.scope.workspaceId)
    .first<{ id: string }>();
  if (activeExport) {
    return json(
      {
        ok: false,
        code: "workspace_export_in_progress",
        error: "Workspace deletion must wait for the active data export to finish.",
      },
      { status: 409 },
    );
  }
  const body = await request.json().catch(() => null);
  const reauthenticatedAt =
    isRecord(body) && typeof body.reauthenticatedAt === "string"
      ? Date.parse(body.reauthenticatedAt)
      : NaN;
  const workspaceName =
    isRecord(body) && typeof body.workspaceName === "string" ? body.workspaceName.trim() : "";
  if (
    workspaceName !== workspace.name ||
    !Number.isFinite(reauthenticatedAt) ||
    reauthenticatedAt > Date.now() + 30_000 ||
    Date.now() - reauthenticatedAt > reauthenticationMaxAgeMs
  ) {
    return json(
      {
        ok: false,
        code: "reauthentication_required",
        error: "Fresh reauthentication and exact workspace-name confirmation are required.",
      },
      { status: 403 },
    );
  }
  const timestamp = new Date().toISOString();
  const e2eFailPhase =
    lifecycleFaultInjectionEnabled(env) &&
    isRecord(body) &&
    [
      "credential_revocation",
      "durable_object_purge",
      "r2_deletion",
      "d1_rows",
      "receipt_creation",
    ].includes(String(body.e2eFailPhase))
      ? String(body.e2eFailPhase)
      : undefined;
  const purgeAfter = e2eFailPhase
    ? new Date(Date.now() - 1_000).toISOString()
    : new Date(Date.now() + deletionRecoveryMs).toISOString();
  const purgeJobId = createId("cf-data-purge");
  const transition = await env.DB.batch([
    env.DB.prepare(
      `UPDATE workspaces SET status = 'quarantined', deletion_requested_by_user_id = ?,
         deletion_requested_at = ?, purge_after = ?, updated_at = ?
       WHERE id = ? AND status = 'active' AND updated_at = ?`,
    ).bind(
      identity.scope.userId,
      timestamp,
      purgeAfter,
      timestamp,
      identity.scope.workspaceId,
      workspace.updated_at,
    ),
    env.DB.prepare(
      `UPDATE control_triggers SET status = 'paused', secret_hash = NULL, version = version + 1,
         updated_at = ? WHERE workspace_id = ? AND status = 'enabled'`,
    ).bind(timestamp, identity.scope.workspaceId),
    env.DB.prepare(`UPDATE control_chat_commands SET status = 'cancelled', error_code = 'workspace_quarantined', updated_at = ?
      WHERE workspace_id = ? AND status IN ('pending','running')`).bind(
      timestamp,
      identity.scope.workspaceId,
    ),
    env.DB.prepare(
      `UPDATE control_runs SET status = 'cancelled', cancelled_at = ?, updated_at = ?
       WHERE workspace_id = ? AND status IN ('queued', 'running', 'waiting', 'interrupted')`,
    ).bind(timestamp, timestamp, identity.scope.workspaceId),
    env.DB.prepare(
      `UPDATE control_workflow_intents SET status = 'cancelled', updated_at = ?
       WHERE workspace_id = ? AND status IN ('queued', 'running', 'waiting', 'interrupted')`,
    ).bind(timestamp, identity.scope.workspaceId),
    env.DB.prepare(
      `UPDATE control_approval_requests SET status = 'cancelled', updated_at = ?
       WHERE workspace_id = ? AND status = 'requested'`,
    ).bind(timestamp, identity.scope.workspaceId),
    env.DB.prepare(
      `UPDATE control_tool_calls SET status = 'cancelled', finished_at = ?,
         data_json = json_set(data_json, '$.cancellationReason', 'workspace_quarantined')
       WHERE workspace_id = ? AND status IN ('queued', 'running', 'waiting')`,
    ).bind(timestamp, identity.scope.workspaceId),
    env.DB.prepare(
      `INSERT INTO control_action_ledger (
         id, user_id, workspace_id, agent_id, proposal_id, sequence, status, summary,
         data_json, created_at
       ) SELECT 'cf-action-ledger-' || lower(hex(randomblob(16))), proposal.user_id,
         proposal.workspace_id, proposal.agent_id, proposal.id,
         COALESCE((SELECT MAX(existing.sequence) FROM control_action_ledger existing
                   WHERE existing.proposal_id = proposal.id), 0) + 1,
         'cancelled', 'Workspace deletion revoked pending mutation authority.', '{}', ?
       FROM control_action_proposals proposal WHERE proposal.workspace_id = ?
         AND proposal.status IN ('proposed', 'approval_requested', 'approved', 'executing')`,
    ).bind(timestamp, identity.scope.workspaceId),
    env.DB.prepare(
      `UPDATE control_action_proposals SET status = 'cancelled',
         error_json = '{"code":"workspace_quarantined"}', terminal_at = ?,
         version = version + 1, updated_at = ? WHERE workspace_id = ?
         AND status IN ('proposed', 'approval_requested', 'approved', 'executing')`,
    ).bind(timestamp, timestamp, identity.scope.workspaceId),
    env.DB.prepare(
      `INSERT INTO control_kill_switches (id, user_id, workspace_id, scope_kind, scope_id, enabled,
         reason, created_by_user_id, version, created_at, updated_at)
       SELECT ?, ?, ?, 'workspace', ?, 1, 'Workspace is pending deletion.', ?, 1, ?, ?
       WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND status = 'quarantined' AND updated_at = ?)
       ON CONFLICT(user_id, workspace_id, scope_kind, scope_id) DO UPDATE SET
         enabled = 1, reason = excluded.reason, version = control_kill_switches.version + 1,
         updated_at = excluded.updated_at`,
    ).bind(
      createId("cf-kill-switch"),
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.scope.workspaceId,
      identity.scope.userId,
      timestamp,
      timestamp,
      identity.scope.workspaceId,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO control_data_jobs (id, user_id, workspace_id, kind, status, cursor_json,
         expires_at, created_by_user_id, created_at, updated_at)
       SELECT ?, ?, ?, 'purge', 'queued', ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND status = 'quarantined' AND updated_at = ?)`,
    ).bind(
      purgeJobId,
      identity.scope.userId,
      identity.scope.workspaceId,
      toJson(e2eFailPhase ? { e2eFailPhase, e2eFailuresRemaining: 3 } : {}),
      purgeAfter,
      identity.scope.userId,
      timestamp,
      timestamp,
      identity.scope.workspaceId,
      timestamp,
    ),
  ]);
  if ((transition[0]?.meta?.changes ?? 0) === 0) {
    return json(
      {
        ok: false,
        code: "workspace_transition_conflict",
        error: "Workspace deletion lost a concurrent transition.",
      },
      { status: 409 },
    );
  }
  const [revocation, deviceRevocation] = await Promise.all([
    revokeWorkspaceConnections(env, identity),
    revokeWorkspaceDevices(env, identity.scope.workspaceId),
  ]);
  if (revocation.failed > 0 || deviceRevocation.failed > 0) {
    await prepareOperatorAlertStatement(env, {
      userId: identity.scope.userId,
      workspaceId: identity.scope.workspaceId,
      severity: "critical",
      code: "workspace_credential_revocation_incomplete",
      summary: "Workspace access is quarantined, but credential cleanup requires retry.",
      targetType: "workspace",
      targetId: identity.scope.workspaceId,
      dedupKey: `workspace-credential-revocation:${identity.scope.workspaceId}`,
      data: { failed: revocation.failed, deviceFailed: deviceRevocation.failed },
      timestamp,
    }).run();
  }
  return json(
    {
      ok: true,
      deletion: {
        status: "quarantined",
        requestedAt: timestamp,
        purgeAfter,
        purgeJobId,
        credentialsRecoverable: false,
        credentialRevocation:
          revocation.failed === 0 && deviceRevocation.failed === 0 ? "completed" : "pending_retry",
      },
    },
    { status: 202 },
  );
};

export const handleGetWorkspaceDeletion = async (env: Env, identity: AgentIdentity) => {
  const workspace = await selectWorkspace(env, identity.scope.workspaceId);
  if (!workspace || !["quarantined", "purging", "failed"].includes(workspace.status)) {
    return json({ ok: false, error: "Workspace deletion not found." }, { status: 404 });
  }
  if (workspace.deletion_requested_by_user_id !== identity.scope.userId)
    return json({ ok: false, error: "Workspace deletion not found." }, { status: 404 });
  const job = await env.DB.prepare(
    `SELECT id, status, cursor_json, attempt_count, manual_retry_count, last_error_code,
            last_failed_at, created_at, updated_at
     FROM control_data_jobs
     WHERE workspace_id = ? AND kind = 'purge'
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(identity.scope.workspaceId)
    .first<{
      id: string;
      status: string;
      cursor_json: string;
      attempt_count: number;
      manual_retry_count: number;
      last_error_code: string | null;
      last_failed_at: string | null;
      created_at: string;
      updated_at: string;
    }>();
  const cursor = parseDataJson(job?.cursor_json ?? "{}");
  return json({
    ok: true,
    deletion: {
      status: workspace.status,
      requestedAt: workspace.deletion_requested_at,
      purgeAfter: workspace.purge_after,
      credentialsRecoverable: false,
      purgeJobId: job?.id,
      phase: typeof cursor.phase === "string" ? cursor.phase : undefined,
      attemptCount: job?.attempt_count,
      manualRetryCount: job?.manual_retry_count,
      lastErrorCode: job?.last_error_code ?? undefined,
      lastFailedAt: job?.last_failed_at ?? undefined,
      canRetry: workspace.status === "failed" && job?.status === "failed",
      canRecover: workspace.status === "quarantined",
    },
  });
};

export const queueFailedWorkspacePurge = async (
  env: Env,
  input: {
    workspaceId: string;
    jobId: string;
    actorUserId: string;
    actorAgentId: string;
    source: "initiating_owner" | "platform_operator";
    reason: string;
    requireOpenCriticalAlert: boolean;
  },
) => {
  const timestamp = new Date().toISOString();
  const data = toJson({ source: input.source, reason: input.reason });
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE workspaces SET status = 'purging', updated_at = ?
       WHERE id = ? AND status = 'failed'
         AND EXISTS (SELECT 1 FROM control_data_jobs WHERE id = ? AND workspace_id = ?
                     AND kind = 'purge' AND status = 'failed')
         AND (? = 0 OR EXISTS (
           SELECT 1 FROM control_operator_alerts WHERE workspace_id = ?
             AND target_type = 'dataJob' AND target_id = ?
             AND code = 'data_lifecycle_job_failed' AND severity = 'critical'
             AND status = 'open'
         ))`,
    ).bind(
      timestamp,
      input.workspaceId,
      input.jobId,
      input.workspaceId,
      input.requireOpenCriticalAlert ? 1 : 0,
      input.workspaceId,
      input.jobId,
    ),
    env.DB.prepare(
      `UPDATE control_data_jobs SET status = 'queued', lease_owner = NULL,
         lease_expires_at = NULL, manual_retry_count = manual_retry_count + 1, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND kind = 'purge' AND status = 'failed'
         AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND status = 'purging'
                     AND updated_at = ?)`,
    ).bind(timestamp, input.jobId, input.workspaceId, input.workspaceId, timestamp),
    env.DB.prepare(
      `UPDATE control_operator_alerts SET status = 'acknowledged', updated_at = ?
       WHERE workspace_id = ? AND target_type = 'dataJob' AND target_id = ?
         AND code = 'data_lifecycle_job_failed' AND status = 'open'`,
    ).bind(timestamp, input.workspaceId, input.jobId),
    env.DB.prepare(
      `INSERT INTO control_audit_events (
         id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
       ) SELECT ?, ?, ?, 'workspace.purge.retry_requested', ?, 'dataJob', ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM control_data_jobs WHERE id = ? AND status = 'queued'
                     AND updated_at = ?)`,
    ).bind(
      createId("cf-audit"),
      input.actorUserId,
      input.workspaceId,
      input.source === "platform_operator"
        ? "A platform operator requested recovery of an orphaned failed workspace purge."
        : "An owner requested a manual retry of a failed workspace purge.",
      input.jobId,
      data,
      timestamp,
      input.jobId,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO control_plane_events (
         id, user_id, workspace_id, agent_id, type, summary, target_type, target_id,
         data_json, created_at
       ) SELECT ?, ?, ?, ?, 'workspace.purge.retry_requested',
         'Failed workspace purge queued for manual retry.', 'dataJob', ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM control_data_jobs WHERE id = ? AND status = 'queued'
                     AND updated_at = ?)`,
    ).bind(
      createId("cf-event"),
      input.actorUserId,
      input.workspaceId,
      input.actorAgentId,
      input.jobId,
      data,
      timestamp,
      input.jobId,
      timestamp,
    ),
  ]);
  return {
    queued: (results[0]?.meta?.changes ?? 0) > 0 && (results[1]?.meta?.changes ?? 0) > 0,
    timestamp,
  };
};

export const handleRetryWorkspaceDeletion = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
) => {
  const ownerError = await requireLifecycleOwner(env, identity);
  if (ownerError) return ownerError;
  const workspace = await selectWorkspace(env, identity.scope.workspaceId);
  if (
    !workspace ||
    workspace.status !== "failed" ||
    workspace.deletion_requested_by_user_id !== identity.scope.userId
  ) {
    return json({ ok: false, error: "Workspace deletion not found." }, { status: 404 });
  }
  const body = await request.json().catch(() => null);
  const reauthenticatedAt =
    isRecord(body) && typeof body.reauthenticatedAt === "string"
      ? Date.parse(body.reauthenticatedAt)
      : NaN;
  const workspaceName =
    isRecord(body) && typeof body.workspaceName === "string" ? body.workspaceName.trim() : "";
  if (
    workspaceName !== workspace.name ||
    !Number.isFinite(reauthenticatedAt) ||
    reauthenticatedAt > Date.now() + 30_000 ||
    Date.now() - reauthenticatedAt > reauthenticationMaxAgeMs
  ) {
    return json(
      {
        ok: false,
        code: "reauthentication_required",
        error: "Fresh reauthentication and exact workspace-name confirmation are required.",
      },
      { status: 403 },
    );
  }
  const job = await env.DB.prepare(
    `SELECT id, status FROM control_data_jobs
     WHERE workspace_id = ? AND kind = 'purge'
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(identity.scope.workspaceId)
    .first<{ id: string; status: string }>();
  if (!job || job.status !== "failed") {
    return json(
      { ok: false, code: "purge_retry_conflict", error: "Workspace purge is not retryable." },
      { status: 409 },
    );
  }
  const retry = await queueFailedWorkspacePurge(env, {
    workspaceId: identity.scope.workspaceId,
    jobId: job.id,
    actorUserId: identity.scope.userId,
    actorAgentId: identity.agentId,
    source: "initiating_owner",
    reason: "Initiating owner requested manual retry.",
    requireOpenCriticalAlert: false,
  });
  if (!retry.queued) {
    return json(
      {
        ok: false,
        code: "purge_retry_conflict",
        error: "Workspace purge retry lost a concurrent transition.",
      },
      { status: 409 },
    );
  }
  return json(
    {
      ok: true,
      deletion: {
        status: "purging",
        purgeJobId: job.id,
        credentialsRecoverable: false,
        canRetry: false,
      },
    },
    { status: 202 },
  );
};

export const handleOperatorRetryWorkspaceDeletion = async (
  request: Request,
  env: Env,
  operator: AgentIdentity,
  targetWorkspaceId: string,
  signedFacade: boolean,
) => {
  if (
    !signedFacade ||
    request.headers.get("x-assistant-mk1-platform-operator")?.trim() !== "true"
  ) {
    return json({ ok: false, error: "Not found." }, { status: 404 });
  }
  const body = await request.json().catch(() => null);
  const workspaceName =
    isRecord(body) && typeof body.workspaceName === "string" ? body.workspaceName.trim() : "";
  const reason = isRecord(body) && typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 10 || reason.length > 500) {
    return json(
      { ok: false, code: "operator_reason_required", error: "An operator reason is required." },
      { status: 400 },
    );
  }
  const workspace = await selectWorkspace(env, targetWorkspaceId);
  if (!workspace || workspace.status !== "failed" || workspace.name !== workspaceName) {
    return json({ ok: false, error: "Workspace deletion not found." }, { status: 404 });
  }
  const job = await env.DB.prepare(
    `SELECT id, status FROM control_data_jobs
     WHERE workspace_id = ? AND kind = 'purge'
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(targetWorkspaceId)
    .first<{ id: string; status: string }>();
  if (!job || job.status !== "failed") {
    return json({ ok: false, error: "Workspace deletion not found." }, { status: 404 });
  }
  const retry = await queueFailedWorkspacePurge(env, {
    workspaceId: targetWorkspaceId,
    jobId: job.id,
    actorUserId: operator.scope.userId,
    actorAgentId: operator.agentId,
    source: "platform_operator",
    reason,
    requireOpenCriticalAlert: true,
  });
  if (!retry.queued) {
    return json(
      {
        ok: false,
        code: "purge_retry_conflict",
        error: "Workspace purge is not retryable or its critical alert is not open.",
      },
      { status: 409 },
    );
  }
  return json(
    {
      ok: true,
      deletion: {
        status: "purging",
        purgeJobId: job.id,
        credentialsRecoverable: false,
        canRetry: false,
      },
    },
    { status: 202 },
  );
};

export const handleRecoverWorkspace = async (env: Env, identity: AgentIdentity) => {
  const workspace = await selectWorkspace(env, identity.scope.workspaceId);
  if (
    !workspace ||
    workspace.status !== "quarantined" ||
    workspace.deletion_requested_by_user_id !== identity.scope.userId
  ) {
    return json({ ok: false, error: "Workspace deletion not found." }, { status: 404 });
  }
  if (!workspace.purge_after || workspace.purge_after <= new Date().toISOString())
    return json(
      { ok: false, code: "recovery_expired", error: "Workspace recovery period has expired." },
      { status: 410 },
    );
  const revocation = await revokeWorkspaceConnections(env, identity);
  if (revocation.failed > 0) {
    return json(
      {
        ok: false,
        code: "credential_revocation_incomplete",
        error: "Workspace recovery is blocked until credential cleanup succeeds.",
      },
      { status: 503 },
    );
  }
  const timestamp = new Date().toISOString();
  const recovered = await env.DB.batch([
    env.DB.prepare(
      `UPDATE workspaces SET status = 'active', deletion_requested_by_user_id = NULL,
         deletion_requested_at = NULL, purge_after = NULL, updated_at = ?
       WHERE id = ? AND status = 'quarantined' AND updated_at = ?`,
    ).bind(timestamp, identity.scope.workspaceId, workspace.updated_at),
    env.DB.prepare(
      `UPDATE control_data_jobs SET status = 'cancelled', updated_at = ?
       WHERE user_id = ? AND workspace_id = ? AND kind = 'purge' AND status IN ('queued', 'running')
         AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND status = 'active' AND updated_at = ?)`,
    ).bind(
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.scope.workspaceId,
      timestamp,
    ),
    env.DB.prepare(
      `UPDATE control_kill_switches SET enabled = 0, reason = 'Workspace deletion was recovered.',
         version = version + 1, updated_at = ? WHERE user_id = ? AND workspace_id = ?
         AND scope_kind = 'workspace' AND scope_id = ?
         AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND status = 'active' AND updated_at = ?)`,
    ).bind(
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.scope.workspaceId,
      identity.scope.workspaceId,
      timestamp,
    ),
  ]);
  if ((recovered[0]?.meta?.changes ?? 0) === 0) {
    return json(
      {
        ok: false,
        code: "workspace_transition_conflict",
        error: "Workspace recovery lost a concurrent purge transition.",
      },
      { status: 409 },
    );
  }
  return json({
    ok: true,
    deletion: {
      status: "recovered",
      recoveredAt: timestamp,
      credentialsRestored: false,
      triggersRestored: false,
    },
  });
};

export const handleWorkspaceDeletionPlan = async (env: Env, identity: AgentIdentity) => {
  const adminError = await requireLifecycleAdmin(env, identity);
  if (adminError) return adminError;
  const collections = await loadCollections(env, identity);
  const r2Objects = (
    (collections.control_artifacts ?? []) as unknown as ControlArtifactRow[]
  ).filter((artifact) => artifact.storage_provider === "r2" && !artifact.deleted_at).length;
  const executable = retainedDataEnabled(env);
  return json({
    ok: true,
    plan: {
      scope: identity.scope,
      d1RowsByCollection: Object.fromEntries(
        Object.entries(collections).map(([name, rows]) => [name, rows.length]),
      ),
      r2Objects,
      executable,
      recoveryDays: 30,
      blockers: executable
        ? []
        : [
            "Retained-data lifecycle feature gate is disabled.",
            "Use the asynchronous export and deletion evidence gates before enabling it.",
          ],
      irreversibleOnConfirmation: [
        "connection credentials",
        "webhook secrets",
        "pending approvals",
      ],
    },
  });
};
