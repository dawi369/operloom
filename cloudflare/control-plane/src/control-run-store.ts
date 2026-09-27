import { parseDataJson, parseJson } from "./http";
import { readControlRunRelation } from "./run-relations";
import { toHumanInterventionSummary } from "./human-interventions";
import {
  createId,
  toJson,
  type AgentIdentity,
  type ControlArtifactRow,
  type ControlApprovalRequestRow,
  type ControlAuditRow,
  type ControlDecisionRow,
  type ControlIntentRow,
  type ControlRunRow,
  type ControlToolCallRow,
  type Env,
  type RunStatus,
  type TenantScope,
} from "./types";

type ControlAuditInput = AgentIdentity &
  Partial<RunIdentity> & {
    action: string;
    summary: string;
    targetType?: string;
    targetId?: string;
    data?: Record<string, unknown>;
  };

type ControlRunStatusInput = ScopedRunIdentity & {
  status: RunStatus;
  summary?: string;
  data?: Record<string, unknown>;
};

type RunIdentity = {
  runId: string;
  workflowIntentId: string;
};

type ScopedRunIdentity = AgentIdentity & RunIdentity;

const scopeFromRow = (row: { user_id: string; workspace_id: string }): TenantScope => ({
  userId: row.user_id,
  workspaceId: row.workspace_id,
});

const toIntent = (row: ControlIntentRow) => ({
  id: row.id,
  scope: scopeFromRow(row),
  agentId: row.agent_id,
  stage: row.stage,
  type: row.type,
  execution: parseDataJson(row.execution_json),
  payload: parseDataJson(row.payload_json),
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toRun = (row: ControlRunRow) => {
  const data = parseDataJson(row.data_json);
  return {
    id: row.id,
    scope: scopeFromRow(row),
    agentId: row.agent_id,
    workflowIntentId: row.workflow_intent_id,
    status: row.status,
    execution: parseDataJson(row.execution_json),
    stage: row.stage ?? undefined,
    engine: row.engine ?? undefined,
    heartbeatAt: row.heartbeat_at ?? undefined,
    lastEventAt: row.last_event_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    failedAt: row.failed_at ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
    relation: readControlRunRelation(data, row.id) ?? undefined,
    data,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const toToolCall = (row: ControlToolCallRow) => {
  const data = parseDataJson(row.data_json);
  return {
    id: row.id,
    scope: scopeFromRow(row),
    agentId: row.agent_id,
    workflowIntentId: row.workflow_intent_id,
    runId: row.run_id,
    toolId: row.tool_id,
    status: row.status,
    inputSummary: row.input_summary ?? undefined,
    outputSummary: row.output_summary ?? undefined,
    artifactRefs: parseJson(row.artifact_refs_json) ?? [],
    relation: readControlRunRelation(data) ?? undefined,
    data,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    createdAt: row.created_at,
  };
};

const toChildRunSummary = (row: ControlRunRow) => {
  const data = parseDataJson(row.data_json);
  return {
    id: row.id,
    workflowIntentId: row.workflow_intent_id,
    agentId: row.agent_id,
    status: row.status,
    stage: row.stage ?? undefined,
    engine: row.engine ?? undefined,
    relation: readControlRunRelation(data, row.id) ?? undefined,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
};

const toArtifact = (row: ControlArtifactRow) => ({
  id: row.id,
  scope: scopeFromRow(row),
  kind: row.kind,
  uri: row.uri,
  title: row.title ?? undefined,
  mimeType: row.mime_type ?? undefined,
  sizeBytes: row.size_bytes ?? undefined,
  data: parseDataJson(row.data_json),
  createdAt: row.created_at,
});

const toDecision = (row: ControlDecisionRow) => ({
  id: row.id,
  scope: scopeFromRow(row),
  agentId: row.agent_id,
  title: row.title,
  summary: row.summary,
  thesis: row.thesis,
  status: row.status,
  provenanceRefs: parseJson(row.provenance_refs_json) ?? [],
  artifactRefs: parseJson(row.artifact_refs_json) ?? [],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toAuditEvent = (row: ControlAuditRow) => ({
  id: row.id,
  scope: scopeFromRow(row),
  actor: { type: "system", name: "Cloudflare Control Plane" },
  action: row.action,
  summary: row.summary,
  target:
    row.target_type && row.target_id ? { type: row.target_type, id: row.target_id } : undefined,
  data: parseDataJson(row.data_json),
  createdAt: row.created_at,
});

export const appendControlAudit = async (env: Env, input: ControlAuditInput) => {
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO control_audit_events (
       id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      createId("cf-audit"),
      input.scope.userId,
      input.scope.workspaceId,
      input.action,
      input.summary,
      input.targetType,
      input.targetId,
      toJson({
        eventName: input.action,
        runId: input.runId,
        workflowIntentId: input.workflowIntentId,
        ...input.data,
      }),
      timestamp,
    )
    .run();
};

const readControlRun = async (env: Env, scope: TenantScope, runId: string) =>
  env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, workflow_intent_id, status, execution_json,
            stage, engine, heartbeat_at, last_event_at, completed_at, failed_at, data_json,
            created_at, updated_at
     FROM control_runs
     WHERE user_id = ? AND workspace_id = ? AND id = ?
     LIMIT 1`,
  )
    .bind(scope.userId, scope.workspaceId, runId)
    .first<ControlRunRow>();

export const readLatestControlRun = async (env: Env, scope: TenantScope) =>
  env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, workflow_intent_id, status, execution_json,
            stage, engine, heartbeat_at, last_event_at, completed_at, failed_at, data_json,
            created_at, updated_at
     FROM control_runs
     WHERE user_id = ? AND workspace_id = ?
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
  )
    .bind(scope.userId, scope.workspaceId)
    .first<ControlRunRow>();

export const readStoredRunIdentity = async (
  env: Env,
  input: RunIdentity,
): Promise<ScopedRunIdentity | null> => {
  const run = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, workflow_intent_id, status, execution_json,
            stage, engine, heartbeat_at, last_event_at, completed_at, failed_at, data_json,
            created_at, updated_at
     FROM control_runs
     WHERE id = ? AND workflow_intent_id = ?
     LIMIT 1`,
  )
    .bind(input.runId, input.workflowIntentId)
    .first<ControlRunRow>();

  if (!run) return null;

  return {
    scope: scopeFromRow(run),
    agentId: run.agent_id,
    runId: run.id,
    workflowIntentId: run.workflow_intent_id,
  };
};

export const getControlRunSnapshot = async (env: Env, scope: TenantScope, runId: string) => {
  const runRow = await readControlRun(env, scope, runId);
  if (!runRow) return null;

  const intentRow = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, stage, type, execution_json, payload_json,
            status, created_at, updated_at
     FROM control_workflow_intents
     WHERE user_id = ? AND workspace_id = ? AND id = ?
     LIMIT 1`,
  )
    .bind(scope.userId, scope.workspaceId, runRow.workflow_intent_id)
    .first<ControlIntentRow>();

  const toolCalls = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, workflow_intent_id, run_id, tool_id, status,
            input_summary, output_summary, artifact_refs_json, data_json, started_at,
            finished_at, created_at
     FROM control_tool_calls
     WHERE user_id = ? AND workspace_id = ? AND run_id = ?
     ORDER BY created_at ASC`,
  )
    .bind(scope.userId, scope.workspaceId, runId)
    .all<ControlToolCallRow>();

  const artifacts = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, kind, uri, title, mime_type, size_bytes, data_json, created_at
     FROM control_artifacts
     WHERE user_id = ? AND workspace_id = ? AND id LIKE ?
       AND COALESCE(json_extract(data_json, '$.publicationStatus'), 'published') <> 'staged'
     ORDER BY created_at ASC`,
  )
    .bind(scope.userId, scope.workspaceId, `${runId}-%`)
    .all<ControlArtifactRow>();

  const decisions = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, title, summary, thesis, status,
            provenance_refs_json, artifact_refs_json, created_at, updated_at
     FROM control_decisions
     WHERE user_id = ? AND workspace_id = ? AND id LIKE ?
     ORDER BY created_at ASC`,
  )
    .bind(scope.userId, scope.workspaceId, `${runId}-%`)
    .all<ControlDecisionRow>();

  const auditEvents = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, action, summary, target_type, target_id, data_json,
            created_at
     FROM control_audit_events
     WHERE user_id = ? AND workspace_id = ? AND json_extract(data_json, '$.runId') = ?
     ORDER BY created_at ASC`,
  )
    .bind(scope.userId, scope.workspaceId, runId)
    .all<ControlAuditRow>();

  const approvalRequests = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, workflow_intent_id, run_id, tool_id,
            status, reason, data_json, created_at, updated_at
     FROM control_approval_requests
     WHERE user_id = ? AND workspace_id = ? AND run_id = ?
     ORDER BY created_at ASC`,
  )
    .bind(scope.userId, scope.workspaceId, runId)
    .all<ControlApprovalRequestRow>();

  const childRuns = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, workflow_intent_id, status, execution_json,
            stage, engine, heartbeat_at, last_event_at, completed_at, failed_at, data_json,
            created_at, updated_at
     FROM control_runs
     WHERE user_id = ? AND workspace_id = ?
       AND (
         json_extract(data_json, '$.relation.parentRunId') = ?
         OR json_extract(data_json, '$.parentRunId') = ?
       )
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 20`,
  )
    .bind(scope.userId, scope.workspaceId, runId, runId)
    .all<ControlRunRow>();

  return {
    scope,
    intent: intentRow ? toIntent(intentRow) : null,
    run: toRun(runRow),
    toolCalls: toolCalls.results.map(toToolCall),
    artifacts: artifacts.results.map(toArtifact),
    decisions: decisions.results.map(toDecision),
    auditEvents: auditEvents.results.map(toAuditEvent),
    interventions: approvalRequests.results.map((approval) => toHumanInterventionSummary(approval)),
    childRuns: childRuns.results.map(toChildRunSummary),
  };
};

export const updateControlRunStatus = async (env: Env, input: ControlRunStatusInput) => {
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE control_runs
     SET status = ?, heartbeat_at = ?, last_event_at = ?, completed_at = ?,
         failed_at = ?, data_json = json_set(?, '$.agentRevision', COALESCE(json_extract(data_json, '$.agentRevision'), 0)), updated_at = ?
     WHERE user_id = ? AND workspace_id = ? AND id = ?`,
  )
    .bind(
      input.status,
      timestamp,
      timestamp,
      input.status === "completed" ? timestamp : null,
      input.status === "failed" ? timestamp : null,
      toJson({
        displayName: "Workbench execution",
        summary: input.summary,
        ...input.data,
      }),
      timestamp,
      input.scope.userId,
      input.scope.workspaceId,
      input.runId,
    )
    .run();

  await env.DB.prepare(
    `UPDATE control_workflow_intents
     SET status = ?, updated_at = ?
     WHERE user_id = ? AND workspace_id = ? AND id = ?`,
  )
    .bind(
      input.status,
      timestamp,
      input.scope.userId,
      input.scope.workspaceId,
      input.workflowIntentId,
    )
    .run();
};

export const markControlRunFailed = async (
  env: Env,
  input: ScopedRunIdentity & { summary: string; error?: string },
) => {
  await updateControlRunStatus(env, {
    ...input,
    runId: input.runId,
    workflowIntentId: input.workflowIntentId,
    status: "failed",
    summary: input.summary,
    data: { error: input.error },
  });
  await appendControlAudit(env, {
    ...input,
    runId: input.runId,
    workflowIntentId: input.workflowIntentId,
    action: "run.failed",
    summary: input.summary,
    targetType: "run",
    targetId: input.runId,
    data: { error: input.error },
  });
};
