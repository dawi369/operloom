import { selectMembership } from "./authz-store";
import { resolveThreadAgentInstanceName } from "./chat-agent-connection-context";
import { json, parseDataJson } from "./http";
import { requireAdminMembership } from "./membership-policy";
import {
  toJson,
  type AgentIdentity,
  type ChatThreadRow,
  type ControlDataJobRow,
  type D1PreparedStatement,
  type Env,
} from "./types";

export const exportExpiryMs = 7 * 24 * 60 * 60 * 1_000;

export const deletionRecoveryMs = 30 * 24 * 60 * 60 * 1_000;

export const reauthenticationMaxAgeMs = 5 * 60 * 1_000;

export const maximumExportBytes = 110 * 1024 * 1024;

export const collectionPageSize = 500;

export const maximumCollectionRows = 50_000;

export const exportFenceLeaseMs = 10 * 60 * 1_000;

export const exportSnapshotBatchSize = 50;

export type ExportCollection = {
  name: string;
  query: string;
  keyExpression: string;
  bindings: (identity: AgentIdentity) => unknown[];
};

export const tenantCollection = (
  name: string,
  select = "*",
  keyExpression = "id",
): ExportCollection => ({
  name,
  query: `SELECT ${select} FROM ${name} WHERE workspace_id = ?`,
  keyExpression,
  bindings: (identity) => [identity.scope.workspaceId],
});

export const exportCollections: readonly ExportCollection[] = [
  {
    name: "users",
    query:
      "SELECT * FROM users WHERE id IN (SELECT user_id FROM memberships WHERE workspace_id = ?)",
    keyExpression: "id",
    bindings: (identity) => [identity.scope.workspaceId],
  },
  {
    name: "workspaces",
    query: "SELECT * FROM workspaces WHERE id = ?",
    keyExpression: "id",
    bindings: (identity) => [identity.scope.workspaceId],
  },
  tenantCollection("active_workspace_preferences", "*", "user_id || ':' || account_id"),
  tenantCollection("memberships"),
  {
    name: "agents",
    query: "SELECT * FROM agents WHERE workspace_id = ?",
    keyExpression: "id",
    bindings: (identity) => [identity.scope.workspaceId],
  },
  tenantCollection("active_agent_preferences", "*", "user_id || ':' || workspace_id"),
  tenantCollection("tool_permissions"),
  tenantCollection("control_policy_decisions"),
  tenantCollection("control_workflow_intents"),
  tenantCollection("control_runs"),
  tenantCollection("control_chat_commands"),
  tenantCollection("control_context_snapshots"),
  tenantCollection("control_resource_reservations"),
  tenantCollection("control_durable_executions", "*", "run_id"),
  tenantCollection("control_durable_engine_dispatches"),
  tenantCollection("control_durable_approvals"),
  tenantCollection("control_durable_trigger_links", "*", "run_id"),
  tenantCollection("control_durable_steps"),
  tenantCollection("control_durable_step_attempts"),
  tenantCollection("control_durable_step_outcomes"),
  tenantCollection("control_budget_changes"),
  tenantCollection("control_budget_policies", "*", "workspace_id"),
  tenantCollection("control_agent_snapshots"),
  tenantCollection("control_agent_upgrades"),
  tenantCollection("control_approval_requests"),
  tenantCollection("control_tool_calls"),
  tenantCollection("control_artifacts"),
  tenantCollection("control_decisions"),
  tenantCollection("control_managed_state"),
  tenantCollection("control_state_records"),
  tenantCollection("control_state_indexes"),
  tenantCollection("control_state_commits"),
  tenantCollection("control_state_entries"),
  tenantCollection("control_state_outbox"),
  tenantCollection("control_state_schema_heads", "*", "json_array(scope_id, namespace, kind)"),
  tenantCollection("control_state_migrations"),
  tenantCollection("control_state_migration_steps"),
  tenantCollection("control_state_migration_repairs"),

  tenantCollection(
    "control_triggers",
    `id, user_id, workspace_id, agent_id, pack_id, pack_trigger_id, kind, workflow_type,
     status, execution_json, config_json, input_json, max_concurrent_runs, version,
     next_trigger_at, last_triggered_at, created_by_user_id, created_at, updated_at, public_id`,
  ),
  tenantCollection("control_trigger_dispatches"),
  tenantCollection("control_audit_events"),
  tenantCollection("control_operator_alerts"),
  tenantCollection("control_retention_policies", "*", "user_id || ':' || workspace_id"),
  tenantCollection("control_plane_events"),
  tenantCollection("runtime_traces", "*", "trace_id"),
  tenantCollection("runtime_spans", "*", "span_id"),
  tenantCollection("chat_sessions", "*", "session_id"),
  tenantCollection("chat_threads", "*", "thread_id"),
  tenantCollection("chat_intents"),
  tenantCollection("chat_policy_decisions"),
  tenantCollection("chat_runs"),
  tenantCollection(
    "control_connections",
    `id, user_id, workspace_id, agent_id, pack_id, connection_id, provider_id, principal,
     credential_class, status, scopes_json, token_expires_at, last_used_at, last_health_at,
     last_error_code, version, data_json, created_at, updated_at, revoked_at`,
  ),
  tenantCollection("control_action_proposals"),
  tenantCollection(
    "control_action_reviews",
    `id,user_id,workspace_id,agent_id,proposal_id,request_hash,
    json_remove(binding_json,'$.connection.vaultObjectId','$.connection.vaultVersion') AS binding_json,
    expires_at,created_at,preconditions_met`,
  ),
  tenantCollection("control_action_ledger"),
  tenantCollection("control_action_reservations"),
  tenantCollection("control_action_projections"),
  tenantCollection(
    "control_provider_operations",
    "id,user_id,workspace_id,agent_id,proposal_id,review_id,operation_id,operation_version,request_hash,status,result_json,created_at,updated_at",
  ),
  tenantCollection("control_kill_switches"),
  tenantCollection(
    "control_client_devices",
    `id, user_id, workspace_id, installation_id, platform, provider, status, last_seen_at,
     app_version, created_at, updated_at, revoked_at`,
  ),
  tenantCollection("control_notification_preferences"),
  tenantCollection("control_notification_deliveries"),
];

export const workspaceExportOmittedTables = [
  "control_data_jobs",
  "control_workspace_write_fences",
  "control_connection_oauth_states",
  "control_connection_capabilities",
] as const;

export const requireLifecycleAdmin = async (env: Env, identity: AgentIdentity) => {
  const membership = await selectMembership(env, identity.scope.userId, identity.scope.workspaceId);
  return requireAdminMembership(membership);
};

export const requireLifecycleOwner = async (env: Env, identity: AgentIdentity) => {
  const membership = await selectMembership(env, identity.scope.userId, identity.scope.workspaceId);
  return membership?.status === "active" && membership.role === "owner"
    ? null
    : json({ ok: false, error: "Workspace owner membership is required." }, { status: 403 });
};

export const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const sha256Hex = async (bytes: Uint8Array) =>
  bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)));

export const loadCollection = async (
  env: Env,
  identity: AgentIdentity,
  collection: ExportCollection,
) => {
  const rows: Record<string, unknown>[] = [];
  let cursor = "";
  while (rows.length < maximumCollectionRows) {
    const page = await env.DB.prepare(
      `SELECT export_rows.*, CAST(${collection.keyExpression} AS TEXT) AS __export_key
       FROM (${collection.query}) export_rows
       WHERE CAST(${collection.keyExpression} AS TEXT) > ?
       ORDER BY CAST(${collection.keyExpression} AS TEXT) ASC
       LIMIT ?`,
    )
      .bind(...collection.bindings(identity), cursor, collectionPageSize)
      .all<Record<string, unknown> & { __export_key: string }>();
    for (const row of page.results) {
      const { __export_key: key, ...payload } = row;
      cursor = key;
      rows.push(payload);
    }
    if (page.results.length < collectionPageSize) return rows;
  }
  throw new Error(`collection_too_large:${collection.name}`);
};

export const loadCollections = async (env: Env, identity: AgentIdentity) => {
  const collections: Record<string, Record<string, unknown>[]> = {};
  for (const collection of exportCollections) {
    collections[collection.name] = await loadCollection(env, identity, collection);
  }
  return collections;
};

export const jobSummary = (row: ControlDataJobRow) => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  attemptCount: row.attempt_count,
  manualRetryCount: row.manual_retry_count,
  lastErrorCode: row.last_error_code ?? undefined,
  lastFailedAt: row.last_failed_at ?? undefined,
  sizeBytes: row.size_bytes ?? undefined,
  contentSha256: row.content_sha256 ?? undefined,
  expiresAt: row.expires_at ?? undefined,
  error: parseDataJson(row.error_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at ?? undefined,
});

export const selectJob = (env: Env, identity: AgentIdentity, jobId: string) =>
  env.DB.prepare(
    `SELECT id, user_id, workspace_id, kind, status, cursor_json, result_json, error_json,
            storage_key, content_sha256, size_bytes, attempt_count, last_error_code,
            last_failed_at, manual_retry_count, lease_owner,
            lease_expires_at, expires_at, created_by_user_id, created_at, updated_at, completed_at
     FROM control_data_jobs WHERE id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`,
  )
    .bind(jobId, identity.scope.userId, identity.scope.workspaceId)
    .first<ControlDataJobRow>();

export const threadLifecycleRequest = async (
  env: Env,
  thread: ChatThreadRow,
  action: "export" | "purge" | "freeze" | "unfreeze",
  jobId?: string,
) => {
  if (!env.ThreadChatAgent || !env.OPERLOOM_AGENT_CONNECTION_SECRET) {
    throw new Error("durable_object_lifecycle_unavailable");
  }
  const name = await resolveThreadAgentInstanceName(thread);
  const stub = env.ThreadChatAgent.get(env.ThreadChatAgent.idFromName(name));
  const response = await stub.fetch(`https://thread-agent.internal/internal/lifecycle-${action}`, {
    method: "POST",
    headers: { "x-operloom-lifecycle-secret": env.OPERLOOM_AGENT_CONNECTION_SECRET },
    body:
      action === "freeze" || action === "unfreeze"
        ? JSON.stringify({ jobId: jobId ?? "" })
        : undefined,
  });
  if (!response.ok) throw new Error(`durable_object_${action}_failed`);
  return action === "export" || action === "freeze"
    ? ((await response.json()) as {
        messages?: unknown[];
        turnReceipts?: unknown[];
        snapshotAt?: string;
        messageCount?: number;
        contentSha256?: string;
      })
    : null;
};

export const exportStorageKey = (identity: AgentIdentity, jobId: string) =>
  [
    "tenants",
    encodeURIComponent(identity.scope.userId),
    encodeURIComponent(identity.scope.workspaceId),
    "exports",
    `${encodeURIComponent(jobId)}.zip`,
  ].join("/");

export type ExportSnapshotCursor = {
  phase?:
    | "awaiting_quiescence"
    | "fenced"
    | "do_frozen"
    | "d1_materialized"
    | "r2_pinned"
    | "released"
    | "assembling";
  snapshotAt?: string;
  fenceAcquiredAt?: string;
  fenceReleasedAt?: string;
  fenceDurationMs?: number;
  collectionCounts?: Record<string, number>;
  durableObjectThreadCount?: number;
  durableObjectChecksums?: Record<string, string>;
  e2eFailPhase?: "after_d1_materialized" | "after_r2_pinned" | "assembling";
  e2eFailuresRemaining?: number;
};

export const readExportSnapshotCursor = (job: ControlDataJobRow): ExportSnapshotCursor =>
  parseDataJson(job.cursor_json) as ExportSnapshotCursor;

export const updateExportSnapshotCursor = async (
  env: Env,
  job: ControlDataJobRow,
  cursor: ExportSnapshotCursor,
) => {
  const timestamp = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE control_data_jobs SET cursor_json = ?, updated_at = ?
     WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'running'`,
  )
    .bind(toJson(cursor), timestamp, job.id, job.user_id, job.workspace_id)
    .run();
  if (((result as { meta?: { changes?: number } }).meta?.changes ?? 0) === 0) {
    throw new Error("data_job_publication_revoked");
  }
  return cursor;
};

export const batchStatements = async (env: Env, statements: D1PreparedStatement[]) => {
  for (let offset = 0; offset < statements.length; offset += exportSnapshotBatchSize) {
    await env.DB.batch(statements.slice(offset, offset + exportSnapshotBatchSize));
  }
};

export const renewExportFence = async (env: Env, job: ControlDataJobRow) => {
  const timestamp = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + exportFenceLeaseMs).toISOString();
  const renewed = await env.DB.prepare(
    `UPDATE control_workspace_write_fences
     SET lease_expires_at = ?, version = version + 1, updated_at = ?
     WHERE workspace_id = ? AND job_id = ? AND status = 'active'`,
  )
    .bind(leaseExpiresAt, timestamp, job.workspace_id, job.id)
    .run();
  if (((renewed as { meta?: { changes?: number } }).meta?.changes ?? 0) === 0) {
    throw new Error("workspace_export_fence_lost");
  }
};

export const acquireExportFence = async (env: Env, job: ControlDataJobRow) => {
  const timestamp = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + exportFenceLeaseMs).toISOString();
  await env.DB.prepare(
    `INSERT INTO control_workspace_write_fences (
       workspace_id, job_id, status, lease_owner, lease_expires_at, version, acquired_at, updated_at
     ) VALUES (?, ?, 'active', ?, ?, 1, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       job_id = excluded.job_id,
       status = 'active',
       lease_owner = excluded.lease_owner,
       lease_expires_at = excluded.lease_expires_at,
       version = control_workspace_write_fences.version + 1,
       acquired_at = CASE
         WHEN control_workspace_write_fences.job_id = excluded.job_id
           THEN control_workspace_write_fences.acquired_at
         ELSE excluded.acquired_at
       END,
       updated_at = excluded.updated_at
     WHERE control_workspace_write_fences.job_id = excluded.job_id
       OR control_workspace_write_fences.lease_expires_at <= excluded.acquired_at`,
  )
    .bind(
      job.workspace_id,
      job.id,
      job.lease_owner ?? `export:${job.id}`,
      leaseExpiresAt,
      timestamp,
      timestamp,
    )
    .run();
  const owned = await env.DB.prepare(
    `SELECT job_id FROM control_workspace_write_fences
     WHERE workspace_id = ? AND job_id = ? AND status = 'active' AND lease_expires_at > ?`,
  )
    .bind(job.workspace_id, job.id, timestamp)
    .first<{ job_id: string }>();
  if (!owned) throw new Error("workspace_export_fence_conflict");
};

export const listWorkspaceThreads = (env: Env, workspaceId: string) =>
  env.DB.prepare(
    `SELECT thread_id, session_id, user_id, workspace_id, agent_id, status, upstream_json,
            created_at, updated_at, last_seen_at
     FROM chat_threads WHERE workspace_id = ? ORDER BY thread_id ASC`,
  )
    .bind(workspaceId)
    .all<ChatThreadRow>();

export const releaseExportFence = async (env: Env, job: ControlDataJobRow) => {
  const owned = await env.DB.prepare(
    `SELECT job_id FROM control_workspace_write_fences
     WHERE workspace_id = ? AND job_id = ? LIMIT 1`,
  )
    .bind(job.workspace_id, job.id)
    .first<{ job_id: string }>();
  if (!owned) return;
  await env.DB.prepare(
    `UPDATE control_workspace_write_fences SET status = 'releasing', updated_at = ?
     WHERE workspace_id = ? AND job_id = ?`,
  )
    .bind(new Date().toISOString(), job.workspace_id, job.id)
    .run();
  const threads = await listWorkspaceThreads(env, job.workspace_id);
  const failures: string[] = [];
  for (const thread of threads.results) {
    try {
      await threadLifecycleRequest(env, thread, "unfreeze", job.id);
    } catch {
      failures.push(thread.thread_id);
    }
  }
  if (failures.length) {
    throw new Error("durable_object_unfreeze_incomplete");
  }
  await env.DB.prepare(
    `DELETE FROM control_workspace_write_fences WHERE workspace_id = ? AND job_id = ?`,
  )
    .bind(job.workspace_id, job.id)
    .run();
};

export const recordExportFenceReleased = async (
  env: Env,
  job: ControlDataJobRow,
  cursor: ExportSnapshotCursor,
) => {
  const fenceReleasedAt = new Date().toISOString();
  const acquiredAt = Date.parse(cursor.fenceAcquiredAt ?? cursor.snapshotAt ?? fenceReleasedAt);
  return updateExportSnapshotCursor(env, job, {
    ...cursor,
    phase: "released",
    fenceReleasedAt,
    fenceDurationMs: Math.max(0, Date.parse(fenceReleasedAt) - acquiredAt),
  });
};

export const clearExportSnapshot = (env: Env, jobId: string) =>
  env.DB.batch([
    env.DB.prepare("DELETE FROM control_data_export_rows WHERE job_id = ?").bind(jobId),
    env.DB.prepare("DELETE FROM control_data_export_objects WHERE job_id = ?").bind(jobId),
  ]);

export const stageSnapshotRows = async (
  env: Env,
  job: ControlDataJobRow,
  collectionName: string,
  rows: Array<{ key: string; payload: Record<string, unknown> }>,
  timestamp: string,
) => {
  await batchStatements(
    env,
    rows.map((row) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO control_data_export_rows (
           job_id, collection_name, row_key, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      ).bind(job.id, collectionName, row.key, toJson(row.payload), timestamp),
    ),
  );
};

export const pauseE2eExportBoundary = async (env: Env) => {
  const configured = env.OPERLOOM_E2E_EXPORT_PAUSE_MS?.trim();
  if (!configured) return;
  if (env.OPERLOOM_E2E_MODE !== "true") {
    throw new Error("e2e_export_pause_requires_e2e_mode");
  }
  const delayMs = Number(configured);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 2_000) {
    throw new Error("e2e_export_pause_invalid");
  }
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
};

export const lifecycleFaultInjectionEnabled = (env: Env) =>
  env.OPERLOOM_E2E_MODE === "true" || env.OPERLOOM_CONFORMANCE_MODE === "true";
