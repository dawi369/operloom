import { hmacSha256Base64Url } from "../../../lib/workbench/control-plane-signing";
import { selectMembership } from "./authz-store";
import { isRecord, json, parseDataJson } from "./http";
import { requireAdminMembership } from "./membership-policy";
import {
  createId,
  toJson,
  type AgentIdentity,
  type ControlOperatorAlertRow,
  type D1PreparedStatement,
  type Env,
} from "./types";

const maximumDeliveryBatch = 10;
const maximumDeliveryAttempts = 5;
const deliveryTimeoutMs = 5_000;

export const prepareOperatorAlertStatement = (
  env: Env,
  input: {
    userId: string;
    workspaceId: string;
    agentId?: string | null;
    severity: "warning" | "critical";
    code: string;
    summary: string;
    targetType?: string | null;
    targetId?: string | null;
    dedupKey: string;
    data?: Record<string, unknown>;
    timestamp: string;
    conditionSql?: string;
    conditionBindings?: unknown[];
  },
): D1PreparedStatement =>
  env.DB.prepare(
    `INSERT OR IGNORE INTO control_operator_alerts (
       id, user_id, workspace_id, agent_id, severity, code, summary, target_type, target_id,
       status, dedup_key, delivery_status, delivery_attempts, data_json, created_at, updated_at
     ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 'pending', 0, ?, ?, ?
     ${input.conditionSql ? `WHERE ${input.conditionSql}` : ""}`,
  ).bind(
    createId("cf-alert"),
    input.userId,
    input.workspaceId,
    input.agentId ?? null,
    input.severity,
    input.code,
    input.summary,
    input.targetType ?? null,
    input.targetId ?? null,
    input.dedupKey,
    toJson(input.data ?? {}),
    input.timestamp,
    input.timestamp,
    ...(input.conditionBindings ?? []),
  );

const validateAlertWebhookUrl = (env: Env) => {
  const raw = env.OPERLOOM_OPERATOR_ALERT_WEBHOOK_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const isE2eLocalhost =
      env.OPERLOOM_E2E_MODE === "true" &&
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    if (
      (!isE2eLocalhost && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      (!isE2eLocalhost && url.port && url.port !== "443")
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
};

const toAlertSummary = (row: ControlOperatorAlertRow) => ({
  id: row.id,
  severity: row.severity,
  code: row.code,
  summary: row.summary,
  targetType: row.target_type ?? undefined,
  targetId: row.target_id ?? undefined,
  status: row.status,
  deliveryStatus: row.delivery_status,
  deliveryAttempts: row.delivery_attempts,
  lastDeliveryAt: row.last_delivery_at ?? undefined,
  data: parseDataJson(row.data_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const deliverPendingOperatorAlerts = async (
  env: Env,
  input: { now?: Date; limit?: number } = {},
) => {
  const endpoint = validateAlertWebhookUrl(env);
  const secret = env.OPERLOOM_OPERATOR_ALERT_SIGNING_SECRET?.trim();
  if (!endpoint || !secret) return { configured: false, inspected: 0, delivered: 0, failed: 0 };

  const timestamp = (input.now ?? new Date()).toISOString();
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? maximumDeliveryBatch), 1), 25);
  const rows = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, severity, code, summary, target_type,
            target_id, status, dedup_key, delivery_status, delivery_attempts,
            last_delivery_at, data_json, created_at, updated_at
     FROM control_operator_alerts
     WHERE status = 'open' AND delivery_status IN ('pending', 'failed')
       AND delivery_attempts < ?
     ORDER BY created_at ASC
     LIMIT ?`,
  )
    .bind(maximumDeliveryAttempts, limit)
    .all<ControlOperatorAlertRow>();

  let delivered = 0;
  let failed = 0;
  for (const row of rows.results) {
    const body = JSON.stringify({
      version: 1,
      occurredAt: timestamp,
      alert: toAlertSummary(row),
      scope: { userId: row.user_id, workspaceId: row.workspace_id, agentId: row.agent_id },
    });
    const signature = await hmacSha256Base64Url(secret, body);
    let succeeded = false;
    let deliveryFailure: Record<string, unknown> | null = null;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(deliveryTimeoutMs),
        headers: {
          "content-type": "application/json",
          "x-operloom-alert-id": row.id,
          "x-operloom-alert-signature": signature,
        },
        body,
      });
      succeeded = response.ok;
      if (!succeeded) {
        deliveryFailure = { reason: "receiver_rejected", status: response.status };
      }
    } catch (error) {
      succeeded = false;
      deliveryFailure = {
        reason:
          error instanceof DOMException && error.name === "TimeoutError"
            ? "timeout"
            : "fetch_failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
      };
    }
    if (deliveryFailure) {
      console.warn("Operator alert delivery failed", {
        alertId: row.id,
        endpointOrigin: endpoint.origin,
        attempt: row.delivery_attempts + 1,
        ...deliveryFailure,
      });
    }

    const result = await env.DB.prepare(
      `UPDATE control_operator_alerts
       SET delivery_status = ?, delivery_attempts = delivery_attempts + 1,
           last_delivery_at = ?, updated_at = ?
       WHERE id = ? AND status = 'open' AND delivery_status IN ('pending', 'failed')
         AND delivery_attempts = ?`,
    )
      .bind(succeeded ? "delivered" : "failed", timestamp, timestamp, row.id, row.delivery_attempts)
      .run();
    if (((result as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) continue;
    if (succeeded) delivered += 1;
    else failed += 1;
  }
  return { configured: true, inspected: rows.results.length, delivered, failed };
};

const requireAlertAdmin = async (env: Env, identity: AgentIdentity) => {
  const membership = await selectMembership(env, identity.scope.userId, identity.scope.workspaceId);
  return requireAdminMembership(membership);
};

export const handleListOperatorAlerts = async (env: Env, identity: AgentIdentity, url: URL) => {
  const adminError = await requireAlertAdmin(env, identity);
  if (adminError) return adminError;
  const requestedLimit = Number(url.searchParams.get("limit") ?? 25);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
    : 25;
  const rows = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, severity, code, summary, target_type,
            target_id, status, dedup_key, delivery_status, delivery_attempts,
            last_delivery_at, data_json, created_at, updated_at
     FROM control_operator_alerts
     WHERE user_id = ? AND workspace_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, limit)
    .all<ControlOperatorAlertRow>();
  return json({ ok: true, alerts: rows.results.map(toAlertSummary), limit });
};

export const handleUpdateOperatorAlert = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
  alertId: string,
) => {
  const adminError = await requireAlertAdmin(env, identity);
  if (adminError) return adminError;
  const body = await request.json().catch(() => null);
  if (!isRecord(body) || (body.status !== "acknowledged" && body.status !== "resolved")) {
    return json(
      { ok: false, error: "Alert status must be acknowledged or resolved." },
      { status: 400 },
    );
  }
  const timestamp = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE control_operator_alerts
       SET status = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ?
         AND status IN ('open', 'acknowledged')`,
    ).bind(body.status, timestamp, alertId, identity.scope.userId, identity.scope.workspaceId),
    env.DB.prepare(
      `INSERT INTO control_audit_events (
         id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
       ) SELECT ?, ?, ?, ?, ?, 'operatorAlert', ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM control_operator_alerts
         WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = ? AND updated_at = ?
       )`,
    ).bind(
      createId("cf-audit"),
      identity.scope.userId,
      identity.scope.workspaceId,
      `operator.alert.${body.status}`,
      `Operator alert ${body.status}.`,
      alertId,
      toJson({ status: body.status }),
      timestamp,
      alertId,
      identity.scope.userId,
      identity.scope.workspaceId,
      body.status,
      timestamp,
    ),
  ]);
  if (results[0]?.meta?.changes !== 1) {
    return json({ ok: false, error: "Operator alert not found." }, { status: 404 });
  }
  return json({ ok: true, alert: { id: alertId, status: body.status, updatedAt: timestamp } });
};

export const handleRetryOperatorAlertDelivery = async (
  env: Env,
  identity: AgentIdentity,
  alertId: string,
) => {
  const adminError = await requireAlertAdmin(env, identity);
  if (adminError) return adminError;
  const timestamp = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE control_operator_alerts
       SET status = 'open', delivery_status = 'pending', delivery_attempts = 0,
           last_delivery_at = NULL, updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ?
         AND status IN ('open', 'acknowledged') AND delivery_status = 'failed'`,
    ).bind(timestamp, alertId, identity.scope.userId, identity.scope.workspaceId),
    env.DB.prepare(
      `INSERT INTO control_audit_events (
         id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
       ) SELECT ?, ?, ?, 'operator.alert.delivery_retried',
         'Operator alert delivery queued for retry.', 'operatorAlert', ?, '{}', ?
       WHERE EXISTS (
         SELECT 1 FROM control_operator_alerts
         WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'open'
           AND delivery_status = 'pending' AND delivery_attempts = 0 AND updated_at = ?
       )`,
    ).bind(
      createId("cf-audit"),
      identity.scope.userId,
      identity.scope.workspaceId,
      alertId,
      timestamp,
      alertId,
      identity.scope.userId,
      identity.scope.workspaceId,
      timestamp,
    ),
  ]);
  if (results[0]?.meta?.changes !== 1) {
    return json({ ok: false, error: "Failed operator alert not found." }, { status: 404 });
  }
  return json({
    ok: true,
    alert: { id: alertId, deliveryStatus: "pending", updatedAt: timestamp },
  });
};
