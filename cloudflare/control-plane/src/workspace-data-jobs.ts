import { selectWorkspace } from "./authz-store";
import { purgeDurableEngines } from "./durable-engine-lifecycle";
import { revokeWorkspaceConnections } from "./connection-broker";
import { retainedDataEnabled } from "./feature-gates";
import { revokeWorkspaceDevices } from "./notification-delivery";
import { parseDataJson } from "./http";
import { prepareOperatorAlertStatement } from "./operator-alerts";
import {
  toJson,
  type AgentIdentity,
  type ChatThreadRow,
  type ControlDataJobRow,
  type Env,
} from "./types";
import {
  clearExportSnapshot,
  lifecycleFaultInjectionEnabled,
  releaseExportFence,
  runExportJob,
  sha256Hex,
  threadLifecycleRequest,
} from "./workspace-data-export";
import type { ExportSnapshotCursor } from "./workspace-data-export";

export const purgeWorkspace = async (env: Env, identity: AgentIdentity, job: ControlDataJobRow) => {
  const jobAuthoritySql = `SELECT 1 FROM control_data_jobs WHERE id=? AND workspace_id=?
    AND kind='purge' AND status='running' AND lease_owner IS ?
    AND (lease_owner IS NULL OR lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
  const jobAuthorityValues = [job.id, identity.scope.workspaceId, job.lease_owner ?? null];
  const requireJobAuthority = async () => {
    if (
      !(await env.DB.prepare(jobAuthoritySql)
        .bind(...jobAuthorityValues)
        .first())
    )
      throw new Error("workspace_purge_authority_revoked");
  };
  await requireJobAuthority();
  const workspace = await selectWorkspace(env, identity.scope.workspaceId);
  if (
    !workspace ||
    !["quarantined", "purging"].includes(workspace.status) ||
    !workspace.purge_after ||
    workspace.purge_after > new Date().toISOString()
  ) {
    throw new Error("workspace_purge_not_due");
  }
  if (workspace.status === "quarantined") {
    const purgeStartedAt = new Date().toISOString();
    const transition = await env.DB.prepare(
      `UPDATE workspaces SET status = 'purging', updated_at = ?
       WHERE id = ? AND status = 'quarantined' AND updated_at = ?
         AND EXISTS (SELECT 1 FROM control_data_jobs WHERE id = ? AND status = 'running')`,
    )
      .bind(purgeStartedAt, identity.scope.workspaceId, workspace.updated_at, job.id)
      .run();
    if (((transition as { meta?: { changes?: number } }).meta?.changes ?? 0) === 0) {
      throw new Error("workspace_purge_transition_conflict");
    }
  }
  let purgeCursor = parseDataJson(job.cursor_json);
  let purgePhase = typeof purgeCursor.phase === "string" ? purgeCursor.phase : "started";
  const phaseOrder = [
    "started",
    "credentials_revoked",
    "durable_objects_purged",
    "objects_deleted",
  ];
  const phaseReached = (phase: string) =>
    phaseOrder.indexOf(purgePhase) >= phaseOrder.indexOf(phase);
  const checkpoint = async (phase: string) => {
    const timestamp = new Date().toISOString();
    const result = await env.DB.prepare(
      `UPDATE control_data_jobs SET cursor_json = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner IS ?`,
    )
      .bind(
        toJson({ ...purgeCursor, phase, phaseUpdatedAt: timestamp }),
        timestamp,
        job.id,
        job.lease_owner ?? null,
      )
      .run();
    if (((result as { meta?: { changes?: number } }).meta?.changes ?? 0) === 0) {
      throw new Error("workspace_purge_authority_revoked");
    }
    purgePhase = phase;
    purgeCursor = { ...purgeCursor, phase, phaseUpdatedAt: timestamp };
  };
  const injectE2eFailure = async (phase: string) => {
    const configuredPhase =
      lifecycleFaultInjectionEnabled(env) && typeof purgeCursor.e2eFailPhase === "string"
        ? purgeCursor.e2eFailPhase
        : undefined;
    const remaining =
      typeof purgeCursor.e2eFailuresRemaining === "number" ? purgeCursor.e2eFailuresRemaining : 0;
    if (configuredPhase !== phase || remaining <= 0) return;
    const timestamp = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE control_data_jobs SET cursor_json = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner IS ?`,
    )
      .bind(
        toJson({ ...purgeCursor, e2eFailuresRemaining: remaining - 1 }),
        timestamp,
        job.id,
        job.lease_owner ?? null,
      )
      .run();
    throw new Error(`e2e_purge_${phase}_failure`);
  };

  if (!phaseReached("credentials_revoked")) {
    await injectE2eFailure("credential_revocation");
    const [revocation, deviceRevocation] = await Promise.all([
      revokeWorkspaceConnections(env, identity),
      revokeWorkspaceDevices(env, identity.scope.workspaceId),
    ]);
    if (revocation.failed > 0 || deviceRevocation.failed > 0)
      throw new Error("workspace_credential_revocation_incomplete");
    await checkpoint("credentials_revoked");
  }

  if (!phaseReached("durable_objects_purged")) {
    await injectE2eFailure("durable_object_purge");
    const threads = await env.DB.prepare(
      `SELECT thread_id, session_id, user_id, workspace_id, agent_id, status, upstream_json,
              created_at, updated_at, last_seen_at FROM chat_threads
       WHERE workspace_id = ?`,
    )
      .bind(identity.scope.workspaceId)
      .all<ChatThreadRow>();
    for (const thread of threads.results) await threadLifecycleRequest(env, thread, "purge");
    await checkpoint("durable_objects_purged");
  }

  if (!phaseReached("objects_deleted")) {
    await injectE2eFailure("r2_deletion");
    const storageRows = await env.DB.prepare(
      `SELECT storage_key FROM control_artifacts WHERE workspace_id = ? AND storage_key IS NOT NULL
       UNION ALL
       SELECT storage_key FROM control_data_jobs WHERE workspace_id = ? AND storage_key IS NOT NULL`,
    )
      .bind(identity.scope.workspaceId, identity.scope.workspaceId)
      .all<{ storage_key: string }>();
    if (storageRows.results.length && !env.ARTIFACTS)
      throw new Error("artifact_storage_unavailable");
    for (const row of storageRows.results) await env.ARTIFACTS!.delete(row.storage_key);
    await checkpoint("objects_deleted");
  }

  // Run even for historical jobs that already reached objects_deleted.
  // Native deletion receipts survive a partial batch or process interruption.
  await requireJobAuthority();
  if (!(await purgeDurableEngines(env, identity.scope.workspaceId))) return false;

  const tables = [
    "control_webhook_deliveries",
    "control_webhook_endpoints",
    "control_notification_deliveries",
    "control_notification_preferences",
    "control_client_devices",
    "control_connection_capabilities",
    "control_connection_oauth_states",
    "control_connections",
    "control_action_ledger",
    "control_action_reservations",
    "control_action_projections",
    "control_action_reviews",
    "control_provider_operations",
    "control_action_proposals",
    "control_kill_switches",
    "control_operator_alerts",
    "control_trigger_dispatches",
    "control_triggers",
    "control_state_outbox",
    "control_state_migration_steps",
    "control_state_migration_repairs",
    "control_state_migrations",
    "control_state_schema_heads",
    "control_state_entries",
    "control_state_commits",
    "control_state_indexes",
    "control_state_records",
    "control_managed_state",
    "control_decisions",
    "control_artifacts",
    "control_tool_calls",
    "control_approval_requests",
    "control_runs",
    "control_workflow_intents",
    "control_policy_decisions",
    "tool_permissions",
    "control_plane_events",
    "runtime_spans",
    "runtime_traces",
    "control_chat_commands",
    "control_context_snapshots",
    "control_resource_reservations",
    "control_durable_step_outcomes",
    "control_durable_step_attempts",
    "control_durable_steps",
    "control_durable_engine_dispatches",
    "control_durable_approvals",
    "control_durable_trigger_links",
    "control_durable_executions",
    "control_budget_changes",
    "control_budget_policies",
    "control_agent_snapshots",
    "control_agent_upgrades",
    "chat_runs",
    "chat_policy_decisions",
    "chat_intents",
    "chat_threads",
    "chat_sessions",
    "active_agent_preferences",
    "memberships",
    "control_retention_policies",
  ];
  const memberUsers = await env.DB.prepare("SELECT user_id FROM memberships WHERE workspace_id = ?")
    .bind(identity.scope.workspaceId)
    .all<{ user_id: string }>();
  const completedAt = new Date().toISOString();
  await injectE2eFailure("d1_rows");
  await injectE2eFailure("receipt_creation");
  const receipt = await sha256Hex(
    new TextEncoder().encode(`${identity.scope.workspaceId}:${completedAt}`),
  );
  await env.DB.batch([
    // completed_at is NOT NULL: losing the job lease rolls back the whole batch.
    env.DB.prepare(
      `INSERT INTO control_deletion_receipts (receipt_sha256, completed_at)
       VALUES (?, CASE WHEN EXISTS (${jobAuthoritySql}) AND EXISTS (
         SELECT 1 FROM workspaces WHERE id=? AND status='purging'
       ) THEN ? ELSE NULL END)`,
    ).bind(receipt, ...jobAuthorityValues, identity.scope.workspaceId, completedAt),
    ...tables.map((table) =>
      env.DB.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).bind(
        identity.scope.workspaceId,
      ),
    ),
    env.DB.prepare("DELETE FROM agents WHERE workspace_id = ?").bind(identity.scope.workspaceId),
    env.DB.prepare("DELETE FROM active_workspace_preferences WHERE workspace_id = ?").bind(
      identity.scope.workspaceId,
    ),
    env.DB.prepare(`DELETE FROM control_data_jobs WHERE workspace_id = ?`).bind(
      identity.scope.workspaceId,
    ),
    env.DB.prepare(`DELETE FROM workspaces WHERE id = ? AND status = 'purging'`).bind(
      identity.scope.workspaceId,
    ),
    ...memberUsers.results.map((member) =>
      env.DB.prepare(
        `DELETE FROM users WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = ?)`,
      ).bind(member.user_id, member.user_id),
    ),
  ]);
};

export const workspaceHasActiveExecution = async (env: Env, workspaceId: string) => {
  const row = await env.DB.prepare(
    `SELECT (
       EXISTS (
         SELECT 1 FROM control_runs WHERE workspace_id = ?
         AND status IN ('queued', 'running', 'waiting', 'interrupted')
       ) OR EXISTS (
         SELECT 1 FROM chat_runs WHERE workspace_id = ? AND status = 'running'
       ) OR EXISTS (
         SELECT 1 FROM control_action_proposals WHERE workspace_id = ? AND status = 'executing'
       )
     ) AS active`,
  )
    .bind(workspaceId, workspaceId, workspaceId)
    .first<{ active: number }>();
  return row?.active === 1;
};

export const recoverExpiredExportFences = async (env: Env, now: string) => {
  const rows = await env.DB.prepare(
    `SELECT job.id, job.user_id, job.workspace_id, job.kind, job.status, job.cursor_json,
            job.result_json, job.error_json, job.storage_key, job.content_sha256, job.size_bytes,
            job.attempt_count, job.last_error_code, job.last_failed_at, job.manual_retry_count,
            job.lease_owner, job.lease_expires_at, job.expires_at,
            job.created_by_user_id, job.created_at, job.updated_at, job.completed_at
     FROM control_workspace_write_fences fence
     JOIN control_data_jobs job ON job.id = fence.job_id
     WHERE (fence.status = 'active' AND fence.lease_expires_at <= ?)
        OR fence.status = 'releasing'
     ORDER BY fence.lease_expires_at ASC LIMIT 10`,
  )
    .bind(now)
    .all<ControlDataJobRow>();
  for (const job of rows.results) {
    try {
      await releaseExportFence(env, job);
      await clearExportSnapshot(env, job.id);
      await env.DB.prepare(
        `UPDATE control_data_jobs SET status = 'queued', cursor_json = ?, lease_owner = NULL,
           lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      )
        .bind(toJson({ phase: "awaiting_quiescence" } satisfies ExportSnapshotCursor), now, job.id)
        .run();
    } catch (error) {
      const errorCode =
        error instanceof Error
          ? error.message.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 96)
          : "workspace_export_recovery_failed";
      await prepareOperatorAlertStatement(env, {
        userId: job.user_id,
        workspaceId: job.workspace_id,
        severity: "critical",
        code: "workspace_export_fence_recovery_failed",
        summary: "An expired workspace export fence could not fully unfreeze chat state.",
        targetType: "dataJob",
        targetId: job.id,
        dedupKey: `workspace-export:${job.id}:recovery`,
        data: { errorCode },
        timestamp: now,
      })
        .run()
        .catch(() => undefined);
      console.error("Expired workspace export fence recovery failed", {
        jobId: job.id,
        error: errorCode,
      });
    }
  }
};

export const claimJob = async (env: Env, row: ControlDataJobRow, owner: string, now: string) => {
  const leaseExpiresAt = new Date(Date.parse(now) + 15 * 60 * 1_000).toISOString();
  const result = await env.DB.prepare(
    `UPDATE control_data_jobs SET status = 'running', lease_owner = ?, lease_expires_at = ?,
       attempt_count = attempt_count + 1, updated_at = ?
     WHERE id = ? AND status IN ('queued', 'running')
       AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
  )
    .bind(owner, leaseExpiresAt, now, row.id, now)
    .run();
  return ((result as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
};

export const processDataLifecycleJobs = async (
  env: Env,
  input: { now?: Date; owner?: string; limit?: number } = {},
) => {
  if (!retainedDataEnabled(env)) return { inspected: 0, completed: 0, failed: 0 };
  const now = (input.now ?? new Date()).toISOString();
  await recoverExpiredExportFences(env, now);
  const rows = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, kind, status, cursor_json, result_json, error_json,
            storage_key, content_sha256, size_bytes, attempt_count, last_error_code,
            last_failed_at, manual_retry_count, lease_owner,
            lease_expires_at, expires_at, created_by_user_id, created_at, updated_at, completed_at
     FROM control_data_jobs WHERE status IN ('queued', 'running')
       AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
       AND (kind = 'export' OR expires_at IS NULL OR expires_at <= ?)
     ORDER BY created_at ASC LIMIT ?`,
  )
    .bind(now, now, Math.max(1, Math.min(10, input.limit ?? 2)))
    .all<ControlDataJobRow>();
  let completed = 0;
  let failed = 0;
  const owner = input.owner ?? `lifecycle:${crypto.randomUUID()}`;
  for (const row of rows.results) {
    if (row.kind === "export" && (await workspaceHasActiveExecution(env, row.workspace_id))) {
      continue;
    }
    if (!(await claimJob(env, row, owner, now))) continue;
    const identity: AgentIdentity = {
      scope: { userId: row.user_id, workspaceId: row.workspace_id },
      agentId: "lifecycle",
    };
    try {
      const claimed = {
        ...row,
        status: "running" as const,
        attempt_count: row.attempt_count + 1,
        lease_owner: owner,
        lease_expires_at: new Date(Date.parse(now) + 15 * 60 * 1000).toISOString(),
      };
      if (row.kind === "export") await runExportJob(env, identity, claimed);
      else if ((await purgeWorkspace(env, identity, claimed)) === false) {
        // A successful bounded page is progress, not a failed automatic attempt.
        await env.DB.prepare(
          `UPDATE control_data_jobs SET status='queued',attempt_count=attempt_count-1,
            lease_owner=NULL,lease_expires_at=NULL,updated_at=?
           WHERE id=? AND status='running' AND lease_owner=?`,
        )
          .bind(new Date().toISOString(), row.id, owner)
          .run();
        continue;
      }
      completed += 1;
    } catch (error) {
      const timestamp = new Date().toISOString();
      const retryable = row.attempt_count + 1 < 3;
      const errorCode =
        error instanceof Error
          ? error.message
              .split(":", 1)[0]
              .replace(/[^a-zA-Z0-9_.-]/g, "_")
              .slice(0, 96)
          : "data_job_failed";
      const failure = await env.DB.prepare(
        `UPDATE control_data_jobs SET status = ?, error_json = ?, lease_owner = NULL,
           lease_expires_at = NULL, last_error_code = ?, last_failed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?`,
      )
        .bind(
          retryable ? "queued" : "failed",
          toJson({ code: errorCode }),
          errorCode,
          timestamp,
          timestamp,
          row.id,
          owner,
        )
        .run();
      if (((failure as { meta?: { changes?: number } }).meta?.changes ?? 0) === 0) continue;
      failed += 1;
      if (!retryable) {
        if (row.kind === "export") {
          await releaseExportFence(env, row).catch(() => undefined);
          await clearExportSnapshot(env, row.id).catch(() => undefined);
        }
        const failureStatements = [
          prepareOperatorAlertStatement(env, {
            userId: row.user_id,
            workspaceId: row.workspace_id,
            severity: "critical",
            code: "data_lifecycle_job_failed",
            summary: "A customer-data lifecycle job exhausted automatic retries.",
            targetType: "dataJob",
            targetId: row.id,
            dedupKey: `data-lifecycle:${row.id}:failed`,
            data: { kind: row.kind, attempts: row.attempt_count + 1 },
            timestamp,
          }),
        ];
        if (row.kind === "purge") {
          failureStatements.unshift(
            env.DB.prepare(
              `UPDATE workspaces SET status = 'failed', updated_at = ?
             WHERE id = ? AND status = 'purging'`,
            ).bind(timestamp, row.workspace_id),
          );
        }
        await env.DB.batch(failureStatements);
      }
    }
  }
  return { inspected: rows.results.length, completed, failed };
};

export const retryQuarantinedCredentialRevocations = async (
  env: Env,
  input: { limit?: number } = {},
) => {
  const rows = await env.DB.prepare(
    `SELECT id, deletion_requested_by_user_id FROM workspaces
     WHERE status = 'quarantined' AND deletion_requested_by_user_id IS NOT NULL
       AND (
         EXISTS (SELECT 1 FROM control_connections connection
                 WHERE connection.workspace_id = workspaces.id AND connection.status <> 'revoked')
         OR EXISTS (SELECT 1 FROM control_connection_oauth_states oauth
                    WHERE oauth.workspace_id = workspaces.id)
         OR EXISTS (SELECT 1 FROM control_client_devices device
                    WHERE device.workspace_id = workspaces.id AND device.status = 'active')
       )
     ORDER BY deletion_requested_at ASC LIMIT ?`,
  )
    .bind(Math.max(1, Math.min(25, input.limit ?? 5)))
    .all<{ id: string; deletion_requested_by_user_id: string }>();
  let completed = 0;
  let failed = 0;
  for (const workspace of rows.results) {
    const identity: AgentIdentity = {
      scope: {
        userId: workspace.deletion_requested_by_user_id,
        workspaceId: workspace.id,
      },
      agentId: "lifecycle",
    };
    const [result, deviceResult] = await Promise.all([
      revokeWorkspaceConnections(env, identity),
      revokeWorkspaceDevices(env, workspace.id),
    ]);
    if (result.failed > 0 || deviceResult.failed > 0) {
      failed += 1;
      continue;
    }
    completed += 1;
    await env.DB.prepare(
      `UPDATE control_operator_alerts SET status = 'resolved', updated_at = ?
       WHERE workspace_id = ? AND code = 'workspace_credential_revocation_incomplete'
         AND status = 'open'`,
    )
      .bind(new Date().toISOString(), workspace.id)
      .run();
  }
  return { inspected: rows.results.length, completed, failed };
};

export const expireDataExports = async (env: Env, now = new Date()) => {
  const timestamp = now.toISOString();
  const rows = await env.DB.prepare(
    `SELECT id, storage_key FROM control_data_jobs
     WHERE kind = 'export' AND status = 'completed' AND expires_at <= ? LIMIT 25`,
  )
    .bind(timestamp)
    .all<{ id: string; storage_key: string | null }>();
  for (const row of rows.results) {
    if (row.storage_key && env.ARTIFACTS) await env.ARTIFACTS.delete(row.storage_key);
    await env.DB.prepare(
      `UPDATE control_data_jobs SET status = 'expired', storage_key = NULL, updated_at = ?
       WHERE id = ? AND status = 'completed'`,
    )
      .bind(timestamp, row.id)
      .run();
  }
  return { expired: rows.results.length };
};
