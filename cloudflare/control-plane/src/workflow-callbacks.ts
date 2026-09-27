import { appendControlPlaneEvent } from "./control-plane-events";
import { dispatchWorkbenchSessionEvent } from "./session-coordinator";
import { activeRunStatusSql, isTerminalRunStatus } from "./run-transitions";
import { isRecord, json, parseDataJson, parseJson } from "./http";
import { getRuntimeTraceSnapshot, recordSpan, type RuntimeSpanStatus } from "./runtime-traces";
import {
  canonicalServiceRequest,
  serviceContentSha256Header,
  serviceSignatureHeader,
  serviceSignatureNonceHeader,
  serviceSignatureTimestampHeader,
  hmacSha256Base64Url,
  sha256Base64Url,
  sha256Hex,
} from "../../../lib/workbench/control-plane-signing";
import {
  createId,
  toJson,
  type AgentIdentity,
  type ControlRunRow,
  type Env,
  type RunStatus,
} from "./types";

export type WorkflowCallbackEvent =
  | "run.started"
  | "run.progress"
  | "artifact.created"
  | "run.completed"
  | "run.failed";

type WorkflowCallbackError = {
  code: string;
  message: string;
  retryable: boolean;
  redacted: true;
};

type CallbackArtifact = {
  id?: string;
  kind: string;
  uri: string;
  title?: string;
  mimeType?: string;
  sizeBytes?: number;
  data?: Record<string, unknown>;
};

type CallbackToolCall = {
  id: string;
  toolId: string;
  status?: string;
  outputSummary?: string;
  artifactRefs?: unknown[];
  data?: Record<string, unknown>;
};

export type WorkflowCallbackPayload = {
  event: WorkflowCallbackEvent;
  runId: string;
  workflowIntentId: string;
  summary?: string;
  occurredAt?: string;
  sequence?: number;
  traceId?: string;
  progress?: Record<string, unknown>;
  toolCall?: CallbackToolCall;
  artifact?: CallbackArtifact;
  outputSummary?: string;
  error?: string;
  output?: Record<string, unknown>;
};

type StoredCallbackRun = AgentIdentity & {
  runId: string;
  workflowIntentId: string;
  status: RunStatus;
  workflowType?: string;
  data: Record<string, unknown>;
};

const signatureWindowMs = 5 * 60 * 1000;
const maxCallbackBodyBytes = 64 * 1024;
const maxSummaryLength = 240;
const maxErrorLength = 500;
const supportedEvents = new Set<WorkflowCallbackEvent>([
  "run.started",
  "run.progress",
  "artifact.created",
  "run.completed",
  "run.failed",
]);
const forbiddenPayloadKeys = new Set([
  "prompt",
  "prompts",
  "message",
  "messages",
  "log",
  "logs",
  "stdout",
  "stderr",
  "token",
  "secret",
  "password",
  "apiKey",
  "api_key",
]);

const textEncoder = new TextEncoder();

const sha256 = (value: string) => crypto.subtle.digest("SHA-256", textEncoder.encode(value));

const constantTimeEqual = async (leftValue: string, rightValue: string) => {
  const [leftBuffer, rightBuffer] = await Promise.all([sha256(leftValue), sha256(rightValue)]);
  const left = new Uint8Array(leftBuffer);
  const right = new Uint8Array(rightBuffer);
  let diff = left.length ^ right.length;

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return diff === 0;
};

const callbackError = (
  code: string,
  message: string,
  retryable = false,
): WorkflowCallbackError => ({ code, message, retryable, redacted: true });

const errorResponse = (details: WorkflowCallbackError, status: number) =>
  json({ ok: false, error: details.message, details }, { status });

const trimString = (value: unknown, maxLength: number) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
};

const redactText = (value: string) =>
  value
    .replace(/(api[_-]?key|token|secret|password)=?[^\s"']*/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]");

const containsForbiddenPayloadKey = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsForbiddenPayloadKey);
  if (!isRecord(value)) return false;

  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenPayloadKeys.has(key)) return true;
    if (containsForbiddenPayloadKey(nested)) return true;
  }
  return false;
};

const safeRecord = (value: unknown, maxBytes = 8 * 1024) => {
  if (!isRecord(value)) return undefined;
  if (containsForbiddenPayloadKey(value)) return undefined;
  if (JSON.stringify(value).length > maxBytes) return undefined;
  return value;
};

const readArtifact = (value: unknown): CallbackArtifact | WorkflowCallbackError | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return callbackError("invalid_artifact", "artifact must be an object.");
  if (containsForbiddenPayloadKey(value)) {
    return callbackError("invalid_artifact", "artifact contains unsupported raw fields.");
  }

  const kind = trimString(value.kind, 48);
  const uri = trimString(value.uri, 500);
  if (!kind || !uri)
    return callbackError("invalid_artifact", "artifact.kind and artifact.uri are required.");

  const sizeBytes =
    typeof value.sizeBytes === "number" && Number.isFinite(value.sizeBytes)
      ? Math.max(0, Math.trunc(value.sizeBytes))
      : undefined;

  return {
    id: trimString(value.id, 160),
    kind,
    uri,
    title: trimString(value.title, 160),
    mimeType: trimString(value.mimeType, 100),
    sizeBytes,
    data: safeRecord(value.data, 8 * 1024),
  };
};

const readToolCall = (value: unknown): CallbackToolCall | WorkflowCallbackError | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return callbackError("invalid_tool_call", "toolCall must be an object.");
  if (containsForbiddenPayloadKey(value)) {
    return callbackError("invalid_tool_call", "toolCall contains unsupported raw fields.");
  }

  const id = trimString(value.id, 160);
  const toolId = trimString(value.toolId, 160);
  if (!id || !toolId)
    return callbackError("invalid_tool_call", "toolCall.id and toolCall.toolId are required.");

  return {
    id,
    toolId,
    status: trimString(value.status, 48),
    outputSummary: trimString(value.outputSummary, maxSummaryLength),
    artifactRefs: Array.isArray(value.artifactRefs) ? value.artifactRefs.slice(0, 10) : undefined,
    data: safeRecord(value.data, 8 * 1024),
  };
};

export const validateWorkflowCallbackPayload = (
  value: unknown,
): { ok: true; payload: WorkflowCallbackPayload } | { ok: false; error: WorkflowCallbackError } => {
  if (!isRecord(value)) {
    return { ok: false, error: callbackError("invalid_body", "request body must be an object.") };
  }
  if (containsForbiddenPayloadKey(value)) {
    return {
      ok: false,
      error: callbackError("invalid_body", "callback body contains unsupported raw fields."),
    };
  }

  const event = typeof value.event === "string" ? value.event : "";
  const runId = trimString(value.runId, 160);
  const workflowIntentId = trimString(value.workflowIntentId, 160);
  if (!supportedEvents.has(event as WorkflowCallbackEvent)) {
    return { ok: false, error: callbackError("unsupported_event", "unsupported callback event.") };
  }
  if (!runId || !workflowIntentId) {
    return {
      ok: false,
      error: callbackError("invalid_body", "runId and workflowIntentId are required."),
    };
  }

  const artifact = readArtifact(value.artifact);
  if (artifact && "code" in artifact) return { ok: false, error: artifact };
  const toolCall = readToolCall(value.toolCall);
  if (toolCall && "code" in toolCall) return { ok: false, error: toolCall };
  if (event === "artifact.created" && !artifact) {
    return {
      ok: false,
      error: callbackError("invalid_artifact", "artifact is required for artifact.created."),
    };
  }

  const output = safeRecord(value.output, 16 * 1024);
  if (value.output !== undefined && !output) {
    return {
      ok: false,
      error: callbackError("invalid_output", "callback output must be compact redacted metadata."),
    };
  }

  return {
    ok: true,
    payload: {
      event: event as WorkflowCallbackEvent,
      runId,
      workflowIntentId,
      summary: trimString(value.summary, maxSummaryLength),
      occurredAt: trimString(value.occurredAt, 80),
      sequence:
        typeof value.sequence === "number" && Number.isFinite(value.sequence)
          ? Math.trunc(value.sequence)
          : undefined,
      traceId: trimString(value.traceId, 160),
      progress: safeRecord(value.progress, 4 * 1024),
      toolCall,
      artifact,
      outputSummary: trimString(value.outputSummary, maxSummaryLength),
      error:
        typeof value.error === "string"
          ? redactText(value.error).trim().slice(0, maxErrorLength)
          : undefined,
      output,
    },
  };
};

const callbackSigningSecret = (env: Env) => env.OPERLOOM_CALLBACK_SIGNING_SECRET?.trim();

const readAuthHeader = (request: Request, name: string) => request.headers.get(name)?.trim() ?? "";

export const verifyWorkflowCallbackSignature = async (
  request: Request,
  env: Env,
  bodyText: string,
): Promise<{ ok: true } | { ok: false; response: Response }> => {
  const secret = callbackSigningSecret(env);
  if (!secret) {
    return {
      ok: false,
      response: errorResponse(
        callbackError("signature_not_configured", "Callback signing is not configured."),
        500,
      ),
    };
  }

  const signature = readAuthHeader(request, serviceSignatureHeader);
  const timestamp = readAuthHeader(request, serviceSignatureTimestampHeader);
  const nonce = readAuthHeader(request, serviceSignatureNonceHeader);
  const declaredBodyHash = readAuthHeader(request, serviceContentSha256Header);
  if (!signature || !timestamp || !nonce || !declaredBodyHash) {
    return {
      ok: false,
      response: errorResponse(
        callbackError("signature_required", "Signed callback is required."),
        401,
      ),
    };
  }

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > signatureWindowMs) {
    return {
      ok: false,
      response: errorResponse(callbackError("signature_stale", "Signed callback is stale."), 401),
    };
  }

  const actualBodyHash = await sha256Base64Url(bodyText);
  if (!(await constantTimeEqual(actualBodyHash, declaredBodyHash))) {
    return {
      ok: false,
      response: errorResponse(
        callbackError("body_hash_mismatch", "Signed callback body hash is invalid."),
        401,
      ),
    };
  }

  const url = new URL(request.url);
  const canonical = canonicalServiceRequest({
    method: request.method,
    pathWithQuery: `${url.pathname}${url.search}`,
    timestamp,
    nonce,
    bodyHash: declaredBodyHash,
    headers: request.headers,
  });
  const expectedSignature = await hmacSha256Base64Url(secret, canonical);
  if (!(await constantTimeEqual(expectedSignature, signature))) {
    return {
      ok: false,
      response: errorResponse(
        callbackError("signature_invalid", "Signed callback is invalid."),
        401,
      ),
    };
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + signatureWindowMs).toISOString();
  const signatureHash = await sha256Hex(signature);
  await env.DB.prepare(`DELETE FROM control_request_nonces WHERE expires_at <= ?`)
    .bind(now.toISOString())
    .run();
  try {
    await env.DB.prepare(
      `INSERT INTO control_request_nonces (nonce, signature_hash, source, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(nonce, signatureHash, "workflow_callback", now.toISOString(), expiresAt)
      .run();
  } catch {
    return {
      ok: false,
      response: errorResponse(
        callbackError("signature_replay", "Signed callback nonce was already used."),
        401,
      ),
    };
  }

  return { ok: true };
};

const readStoredCallbackRun = async (
  env: Env,
  input: { runId: string; workflowIntentId: string },
): Promise<StoredCallbackRun | null> => {
  const row = await env.DB.prepare(
    `SELECT
       r.id, r.user_id, r.workspace_id, r.agent_id, r.workflow_intent_id, r.status,
       r.execution_json, r.stage, r.engine, r.heartbeat_at, r.last_event_at,
       r.completed_at, r.failed_at, r.data_json, r.created_at, r.updated_at,
       i.type AS workflow_type
     FROM control_runs r
     LEFT JOIN control_workflow_intents i
       ON i.id = r.workflow_intent_id
      AND i.user_id = r.user_id
      AND i.workspace_id = r.workspace_id
     WHERE r.id = ? AND r.workflow_intent_id = ?
     LIMIT 1`,
  )
    .bind(input.runId, input.workflowIntentId)
    .first<ControlRunRow & { workflow_type?: string }>();

  if (!row) return null;
  return {
    scope: { userId: row.user_id, workspaceId: row.workspace_id },
    agentId: row.agent_id,
    runId: row.id,
    workflowIntentId: row.workflow_intent_id,
    status: row.status,
    workflowType: row.workflow_type,
    data: parseDataJson(row.data_json),
  };
};

const mergeUnique = (current: unknown, next: string) => {
  const values = Array.isArray(current)
    ? current.filter((item): item is string => typeof item === "string")
    : [];
  return Array.from(new Set([...values, next])).slice(0, 50);
};

const recordCallbackTraceSpan = async (
  env: Env,
  identity: StoredCallbackRun,
  payload: WorkflowCallbackPayload,
) => {
  if (!payload.traceId) return;
  const snapshot = await getRuntimeTraceSnapshot(env, identity.scope, payload.traceId);
  if (!snapshot) return;
  const startedAt = Date.now();
  const status: RuntimeSpanStatus = payload.event === "run.failed" ? "failed" : "completed";
  await recordSpan(env, identity, {
    traceId: payload.traceId,
    name: "Workflow callback",
    layer: "cloudflare",
    status,
    startedAtMs: startedAt,
    data: {
      event: payload.event,
      runId: identity.runId,
      workflowIntentId: identity.workflowIntentId,
      sequence: payload.sequence,
    },
  });
};

const emitCallbackEvents = async (
  env: Env,
  identity: StoredCallbackRun,
  payload: WorkflowCallbackPayload,
  input: { summary: string; artifactId?: string; controlPlaneEventId?: string },
) => {
  const controlPlaneEventId =
    input.controlPlaneEventId ??
    (await appendControlPlaneEvent(env, identity, {
      type: payload.event,
      summary: input.summary,
      targetType: payload.event === "artifact.created" ? "artifact" : "run",
      targetId: input.artifactId ?? identity.runId,
      data: {
        runId: identity.runId,
        workflowIntentId: identity.workflowIntentId,
        event: payload.event,
        sequence: payload.sequence,
        progress: payload.progress,
        artifactId: input.artifactId,
        toolCallId: payload.toolCall?.id,
      },
    }));
  await dispatchWorkbenchSessionEvent(env, identity, {
    type: "workflow.run.updated",
    data: {
      runId: identity.runId,
      workflowIntentId: identity.workflowIntentId,
      event: payload.event,
      status:
        payload.event === "run.completed"
          ? "completed"
          : payload.event === "run.failed"
            ? "failed"
            : payload.event === "run.started"
              ? "running"
              : identity.status,
      summary: input.summary,
    },
  });
  if (payload.toolCall) {
    await dispatchWorkbenchSessionEvent(env, identity, {
      type: "tool.run.updated",
      data: {
        runId: identity.runId,
        workflowIntentId: identity.workflowIntentId,
        toolCallId: payload.toolCall.id,
        toolId: payload.toolCall.toolId,
        status: payload.toolCall.status,
      },
    });
  }
  await dispatchWorkbenchSessionEvent(env, identity, {
    type: "admin.summary.invalidated",
    data: {
      reason: "workflow_callback",
      runId: identity.runId,
      workflowIntentId: identity.workflowIntentId,
      event: payload.event,
    },
  });
  return controlPlaneEventId;
};

const applyGenericCallback = async (
  env: Env,
  identity: StoredCallbackRun,
  payload: WorkflowCallbackPayload,
) => {
  const timestamp = new Date().toISOString();
  const summary = payload.summary ?? payload.outputSummary ?? `Accepted ${payload.event}.`;
  const artifactId = payload.artifact
    ? (payload.artifact.id ??
      `${identity.runId}-artifact-callback-${payload.sequence ?? createId("cf-artifact")}`)
    : undefined;

  const baseData = {
    lastCallback: {
      event: payload.event,
      sequence: payload.sequence,
      occurredAt: payload.occurredAt,
      summary,
    },
    progress: payload.progress ?? identity.data.progress,
    artifactIds: artifactId
      ? mergeUnique(identity.data.artifactIds, artifactId)
      : identity.data.artifactIds,
    outputSummary: payload.outputSummary ?? identity.data.outputSummary,
    error: payload.error ?? identity.data.error,
  };

  const status: RunStatus =
    payload.event === "run.completed"
      ? "completed"
      : payload.event === "run.failed"
        ? "failed"
        : payload.event === "run.started" || payload.event === "run.progress"
          ? "running"
          : identity.status;
  const auditAction = payload.event;
  const targetType = payload.event === "artifact.created" ? "artifact" : "run";
  const targetId = artifactId ?? identity.runId;
  const controlPlaneEventId = createId("cf-event");
  const statements = [];

  if (payload.artifact && artifactId) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO control_artifacts (
           id, user_id, workspace_id, kind, uri, title, mime_type, size_bytes, data_json, created_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM control_runs
           WHERE user_id = ? AND workspace_id = ? AND id = ? AND status IN ${activeRunStatusSql}
         )
         ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json`,
      ).bind(
        artifactId,
        identity.scope.userId,
        identity.scope.workspaceId,
        payload.artifact.kind,
        payload.artifact.uri,
        payload.artifact.title ?? null,
        payload.artifact.mimeType ?? null,
        payload.artifact.sizeBytes ?? null,
        toJson({
          source: "workflow_callback",
          publicationStatus: "staged",
          callbackEvent: payload.event,
          ...payload.artifact.data,
        }),
        timestamp,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.runId,
      ),
    );
  }

  if (payload.toolCall) {
    const toolStatus =
      payload.toolCall.status ??
      (payload.event === "run.completed"
        ? "completed"
        : payload.event === "run.failed"
          ? "failed"
          : "running");
    statements.push(
      env.DB.prepare(
        `INSERT INTO control_tool_calls (
           id, user_id, workspace_id, agent_id, workflow_intent_id, run_id, tool_id, status,
           input_summary, output_summary, artifact_refs_json, data_json, started_at, finished_at,
           created_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM control_runs
           WHERE user_id = ? AND workspace_id = ? AND id = ? AND status IN ${activeRunStatusSql}
         )
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           output_summary = excluded.output_summary,
           artifact_refs_json = excluded.artifact_refs_json,
           data_json = json_patch(control_tool_calls.data_json, excluded.data_json),
           finished_at = excluded.finished_at`,
      ).bind(
        payload.toolCall.id,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        identity.workflowIntentId,
        identity.runId,
        payload.toolCall.toolId,
        toolStatus,
        null,
        payload.toolCall.outputSummary ?? payload.outputSummary ?? summary,
        toJson(payload.toolCall.artifactRefs ?? []),
        toJson({
          callback: { source: "workflow_callback", event: payload.event },
          ...payload.toolCall.data,
        }),
        timestamp,
        toolStatus === "completed" || toolStatus === "failed" ? timestamp : null,
        timestamp,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.runId,
      ),
    );
  }

  statements.push(
    env.DB.prepare(
      `UPDATE control_workflow_intents
       SET status = ?, updated_at = ?
       WHERE user_id = ? AND workspace_id = ? AND id = ?
         AND EXISTS (
           SELECT 1 FROM control_runs
           WHERE user_id = ? AND workspace_id = ? AND id = ? AND status IN ${activeRunStatusSql}
         )`,
    ).bind(
      status,
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.workflowIntentId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.runId,
    ),
    env.DB.prepare(
      `UPDATE control_runs
       SET status = ?, heartbeat_at = ?, last_event_at = ?, completed_at = ?, failed_at = ?,
           data_json = ?, updated_at = ?
       WHERE user_id = ? AND workspace_id = ? AND id = ? AND status IN ${activeRunStatusSql}`,
    ).bind(
      status,
      timestamp,
      timestamp,
      status === "completed" ? timestamp : null,
      status === "failed" ? timestamp : null,
      toJson({ ...identity.data, summary, lastCallbackAt: timestamp, ...baseData }),
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.runId,
    ),
  );
  const runResultIndex = statements.length - 1;
  const terminalCallback = status === "completed" || status === "failed";
  const leaseExpiresAt = new Date(Date.parse(timestamp) + 2 * 60 * 1000).toISOString();
  statements.push(
    env.DB.prepare(
      `UPDATE control_trigger_dispatches
       SET status = ?, heartbeat_at = ?,
           lease_owner = CASE WHEN ? THEN NULL ELSE lease_owner END,
           lease_expires_at = ?,
           error_json = ?, updated_at = ?
       WHERE user_id = ? AND workspace_id = ? AND agent_id = ? AND run_id = ?
         AND status = 'running'
         AND EXISTS (
           SELECT 1 FROM control_runs
           WHERE user_id = ? AND workspace_id = ? AND id = ? AND status = ? AND updated_at = ?
         )`,
    ).bind(
      terminalCallback ? status : "running",
      timestamp,
      terminalCallback ? 1 : 0,
      terminalCallback ? null : leaseExpiresAt,
      status === "failed" ? toJson(payload.error ?? { code: "workflow_failed" }) : "{}",
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      identity.runId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.runId,
      status,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO control_audit_events (
         id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM control_runs
         WHERE user_id = ? AND workspace_id = ? AND id = ? AND status = ? AND updated_at = ?
       )`,
    ).bind(
      createId("cf-audit"),
      identity.scope.userId,
      identity.scope.workspaceId,
      auditAction,
      summary,
      targetType,
      targetId,
      toJson({
        eventName: auditAction,
        runId: identity.runId,
        workflowIntentId: identity.workflowIntentId,
        progress: payload.progress,
        outputSummary: payload.outputSummary,
        error: payload.error,
      }),
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.runId,
      status,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO control_plane_events (
         id, user_id, workspace_id, agent_id, type, summary, target_type, target_id,
         data_json, created_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM control_runs
         WHERE user_id = ? AND workspace_id = ? AND id = ? AND status = ? AND updated_at = ?
       )`,
    ).bind(
      controlPlaneEventId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      payload.event,
      summary,
      targetType,
      targetId,
      toJson({
        runId: identity.runId,
        workflowIntentId: identity.workflowIntentId,
        event: payload.event,
        sequence: payload.sequence,
        progress: payload.progress,
        artifactId,
        toolCallId: payload.toolCall?.id,
      }),
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.runId,
      status,
      timestamp,
    ),
  );

  const results = await env.DB.batch(statements);
  return {
    applied: results[runResultIndex]?.meta?.changes !== 0,
    summary,
    artifactId,
    controlPlaneEventId,
  };
};

export const applyWorkflowCallbackPayload = async (env: Env, payload: WorkflowCallbackPayload) => {
  const identity = await readStoredCallbackRun(env, payload);
  if (!identity) {
    return {
      ok: false as const,
      response: errorResponse(callbackError("run_not_found", "Callback run was not found."), 404),
    };
  }

  if (isTerminalRunStatus(identity.status)) {
    return {
      ok: false as const,
      response: errorResponse(
        callbackError("run_terminal", "Callback run is already terminal."),
        409,
      ),
    };
  }

  const applied = await applyGenericCallback(env, identity, payload);
  if ("applied" in applied && !applied.applied) {
    return {
      ok: false as const,
      response: errorResponse(
        callbackError("run_terminal", "Callback run is already terminal."),
        409,
      ),
    };
  }
  await recordCallbackTraceSpan(env, identity, payload);
  const controlPlaneEventId = await emitCallbackEvents(env, identity, payload, applied);

  return {
    ok: true as const,
    response: json({
      ok: true,
      run: {
        id: identity.runId,
        status:
          payload.event === "run.completed"
            ? "completed"
            : payload.event === "run.failed"
              ? "failed"
              : payload.event === "run.started"
                ? "running"
                : identity.status,
        workflowIntentId: identity.workflowIntentId,
      },
      acceptedEvent: payload.event,
      controlPlaneEventId,
    }),
  };
};

export const handleWorkflowCallback = async (request: Request, env: Env) => {
  const bodyText = await request.text();
  if (bodyText.length > maxCallbackBodyBytes) {
    return errorResponse(callbackError("body_too_large", "callback body is too large."), 413);
  }

  const auth = await verifyWorkflowCallbackSignature(request, env, bodyText);
  if (!auth.ok) return auth.response;

  const parsedJson = parseJson(bodyText);
  const parsed = validateWorkflowCallbackPayload(parsedJson);
  if (!parsed.ok) return errorResponse(parsed.error, 400);

  const applied = await applyWorkflowCallbackPayload(env, parsed.payload);
  return applied.response;
};
