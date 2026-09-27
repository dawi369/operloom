import { hmacSha256Base64Url } from "../../../lib/workbench/control-plane-signing";
import { selectMembership } from "./authz-store";
import { isRecord, json, parseDataJson, parseJson } from "./http";
import { requireAdminMembership } from "./membership-policy";
import { getRequiredSecret } from "./session-agent-model";
import { createId, type AgentIdentity, type D1Result, type Env } from "./types";

const maximumEndpoints = 10;
const maximumEventTypes = 20;
const maximumAttempts = 8;
const fanoutBatch = 100;
const deliveryBatch = 25;
const deliveryTimeoutMs = 10_000;
const leaseMs = 60_000;
// Event timestamps are taken before commit; the cursor only passes events old enough to be committed.
const settleMs = 30_000;
const retentionMs = 30 * 24 * 60 * 60 * 1000;
const eventTypePattern = /^(\*|[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*(\.\*)?)$/;

type EndpointRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  url: string;
  event_types_json: string;
  status: "active" | "disabled";
  secret_version: number;
  cursor_created_at: string;
  cursor_event_id: string;
  created_at: string;
  updated_at: string;
};
type DeliveryRow = {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  status: "pending" | "delivered" | "failed";
  attempt_count: number;
  next_attempt_at: string;
  last_status_code: number | null;
  last_error_code: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
};

const failure = (status: number, code: string, error: string) =>
  json({ ok: false, code, error }, { status });

/** Derived per endpoint and version, so no signing secret is stored. */
const endpointSecret = async (env: Env, endpoint: Pick<EndpointRow, "id" | "secret_version">) =>
  `whsec_${await hmacSha256Base64Url(
    getRequiredSecret(env),
    `webhook-endpoint:${endpoint.id}:${endpoint.secret_version}`,
  )}`;

/** `x-operloom-signature: v1=<base64url HMAC-SHA256(secret, "<timestamp>.<body>")>` */
export const signWebhookBody = async (secret: string, timestamp: number, body: string) =>
  `v1=${await hmacSha256Base64Url(secret, `${timestamp}.${body}`)}`;

const eventTypesOf = (endpoint: EndpointRow) => JSON.parse(endpoint.event_types_json) as string[];
const subscribes = (types: readonly string[], eventType: string) =>
  types.some(
    (type) =>
      type === "*" ||
      type === eventType ||
      (type.endsWith(".*") && eventType.startsWith(type.slice(0, -1))),
  );

const validEndpointUrl = (env: Env, raw: unknown) => {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    const local =
      (env.OPERLOOM_ENVIRONMENT === "local" || env.OPERLOOM_E2E_MODE === "true") &&
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    if (!local && (url.protocol !== "https:" || (url.port && url.port !== "443"))) return null;
    if (url.username || url.password || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
};

const toEndpoint = (row: EndpointRow) => ({
  id: row.id,
  url: row.url,
  eventTypes: eventTypesOf(row),
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const toDelivery = (row: DeliveryRow) => ({
  id: row.id,
  endpointId: row.endpoint_id,
  eventId: row.event_id,
  eventType: row.event_type,
  status: row.status,
  attempts: row.attempt_count,
  nextAttemptAt: row.status === "pending" ? row.next_attempt_at : undefined,
  lastStatusCode: row.last_status_code ?? undefined,
  lastErrorCode: row.last_error_code ?? undefined,
  deliveredAt: row.delivered_at ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const requireWebhookAdmin = async (env: Env, identity: AgentIdentity) =>
  requireAdminMembership(
    await selectMembership(env, identity.scope.userId, identity.scope.workspaceId),
  );
const selectEndpoint = (env: Env, identity: AgentIdentity, id: string) =>
  env.DB.prepare(
    "SELECT * FROM control_webhook_endpoints WHERE id = ? AND user_id = ? AND workspace_id = ?",
  )
    .bind(id, identity.scope.userId, identity.scope.workspaceId)
    .first<EndpointRow>();

export const handleListWebhooks = async (env: Env, identity: AgentIdentity) => {
  const adminError = await requireWebhookAdmin(env, identity);
  if (adminError) return adminError;
  const rows = await env.DB.prepare(
    `SELECT * FROM control_webhook_endpoints WHERE user_id = ? AND workspace_id = ?
     ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId)
    .all<EndpointRow>();
  return json({ ok: true, endpoints: rows.results.map(toEndpoint) });
};

/** The signing secret is returned once; later reads cannot recover it. */
export const handleCreateWebhook = async (request: Request, env: Env, identity: AgentIdentity) => {
  const adminError = await requireWebhookAdmin(env, identity);
  if (adminError) return adminError;
  const body = parseJson(await request.text());
  const url = validEndpointUrl(env, isRecord(body) ? body.url : undefined);
  const eventTypes = isRecord(body) ? body.eventTypes : undefined;
  if (!url)
    return failure(400, "webhook_url_invalid", "Webhook URLs must be HTTPS without credentials.");
  if (
    !Array.isArray(eventTypes) ||
    !eventTypes.length ||
    eventTypes.length > maximumEventTypes ||
    !eventTypes.every((type) => typeof type === "string" && eventTypePattern.test(type))
  )
    return failure(
      400,
      "webhook_event_types_invalid",
      `eventTypes must list 1-${maximumEventTypes} event types, "prefix.*" patterns or "*".`,
    );
  const now = new Date().toISOString();
  const id = createId("webhook");
  const result = (await env.DB.prepare(
    `INSERT INTO control_webhook_endpoints
       (id, user_id, workspace_id, url, event_types_json, status, secret_version,
        cursor_created_at, cursor_event_id, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, 'active', 1, ?, '', ?, ?
     WHERE (SELECT COUNT(*) FROM control_webhook_endpoints
            WHERE user_id = ? AND workspace_id = ? AND status = 'active') < ?`,
  )
    .bind(
      id,
      identity.scope.userId,
      identity.scope.workspaceId,
      url,
      JSON.stringify([...new Set(eventTypes as string[])]),
      now,
      now,
      now,
      identity.scope.userId,
      identity.scope.workspaceId,
      maximumEndpoints,
    )
    .run()) as D1Result;
  if (!result.meta?.changes)
    return failure(
      409,
      "webhook_limit_reached",
      `A workspace holds at most ${maximumEndpoints} active webhooks per user.`,
    );
  const endpoint = (await selectEndpoint(env, identity, id))!;
  return json(
    { ok: true, endpoint: toEndpoint(endpoint), secret: await endpointSecret(env, endpoint) },
    { status: 201 },
  );
};

export const handleDisableWebhook = async (env: Env, identity: AgentIdentity, id: string) => {
  const adminError = await requireWebhookAdmin(env, identity);
  if (adminError) return adminError;
  const now = new Date().toISOString();
  const [update] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE control_webhook_endpoints SET status = 'disabled', updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ?`,
    ).bind(now, id, identity.scope.userId, identity.scope.workspaceId),
    env.DB.prepare(
      `UPDATE control_webhook_deliveries
       SET status = 'failed', last_error_code = 'endpoint_disabled', lease_expires_at = NULL, updated_at = ?
       WHERE endpoint_id = ? AND user_id = ? AND workspace_id = ? AND status = 'pending'`,
    ).bind(now, id, identity.scope.userId, identity.scope.workspaceId),
  ]);
  if (!update?.meta?.changes) return failure(404, "webhook_not_found", "Webhook not found");
  return json({ ok: true, endpoint: toEndpoint((await selectEndpoint(env, identity, id))!) });
};

export const handleListWebhookDeliveries = async (
  env: Env,
  identity: AgentIdentity,
  id: string,
  url: URL,
) => {
  const adminError = await requireWebhookAdmin(env, identity);
  if (adminError) return adminError;
  if (!(await selectEndpoint(env, identity, id)))
    return failure(404, "webhook_not_found", "Webhook not found");
  const status = url.searchParams.get("status");
  if (status && !["pending", "delivered", "failed"].includes(status))
    return failure(400, "webhook_status_invalid", "status must be pending, delivered or failed");
  const requested = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 100) : 50;
  const rows = await env.DB.prepare(
    `SELECT * FROM control_webhook_deliveries
     WHERE endpoint_id = ? AND user_id = ? AND workspace_id = ? AND (? IS NULL OR status = ?)
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(id, identity.scope.userId, identity.scope.workspaceId, status, status, limit)
    .all<DeliveryRow>();
  return json({ ok: true, deliveries: rows.results.map(toDelivery) });
};

export const handleRetryWebhookDelivery = async (
  env: Env,
  identity: AgentIdentity,
  id: string,
  deliveryId: string,
) => {
  const adminError = await requireWebhookAdmin(env, identity);
  if (adminError) return adminError;
  const now = new Date().toISOString();
  const result = (await env.DB.prepare(
    `UPDATE control_webhook_deliveries
     SET status = 'pending', attempt_count = 0, next_attempt_at = ?, last_error_code = NULL,
         lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND endpoint_id = ? AND user_id = ? AND workspace_id = ? AND status = 'failed'
       AND EXISTS (SELECT 1 FROM control_webhook_endpoints w
                   WHERE w.id = control_webhook_deliveries.endpoint_id AND w.status = 'active')`,
  )
    .bind(now, now, deliveryId, id, identity.scope.userId, identity.scope.workspaceId)
    .run()) as D1Result;
  if (!result.meta?.changes)
    return failure(
      409,
      "webhook_delivery_not_retryable",
      "Only failed deliveries on an active webhook can be retried.",
    );
  return json({ ok: true, deliveryId, status: "pending" });
};

/** Queue one delivery per subscribed event after each endpoint's cursor. */
const fanOut = async (env: Env, at: Date) => {
  const now = at.toISOString();
  const settled = new Date(at.getTime() - settleMs).toISOString();
  const endpoints = await env.DB.prepare(
    `SELECT w.* FROM control_webhook_endpoints w
     JOIN workspaces ws ON ws.id = w.workspace_id AND ws.status = 'active'
     JOIN memberships m ON m.user_id = w.user_id AND m.workspace_id = w.workspace_id
       AND m.status = 'active' AND m.role IN ('owner', 'admin')
     WHERE w.status = 'active' ORDER BY w.updated_at ASC LIMIT 50`,
  ).all<EndpointRow>();
  let queued = 0;
  for (const endpoint of endpoints.results) {
    const events = await env.DB.prepare(
      `SELECT id, type, created_at FROM control_plane_events
       WHERE user_id = ? AND workspace_id = ? AND created_at <= ?
         AND (created_at > ? OR (created_at = ? AND id > ?))
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
      .bind(
        endpoint.user_id,
        endpoint.workspace_id,
        settled,
        endpoint.cursor_created_at,
        endpoint.cursor_created_at,
        endpoint.cursor_event_id,
        fanoutBatch,
      )
      .all<{ id: string; type: string; created_at: string }>();
    const last = events.results.at(-1);
    if (!last) continue;
    const types = eventTypesOf(endpoint);
    const matching = events.results.filter((event) => subscribes(types, event.type));
    const [cursor] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE control_webhook_endpoints SET cursor_created_at = ?, cursor_event_id = ?
         WHERE id = ? AND status = 'active' AND cursor_created_at = ? AND cursor_event_id = ?`,
      ).bind(
        last.created_at,
        last.id,
        endpoint.id,
        endpoint.cursor_created_at,
        endpoint.cursor_event_id,
      ),
      ...matching.map((event) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO control_webhook_deliveries
             (id, endpoint_id, user_id, workspace_id, event_id, event_type, status, attempt_count,
              next_attempt_at, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM control_webhook_endpoints
                         WHERE id = ? AND cursor_event_id = ? AND cursor_created_at = ?)`,
        ).bind(
          createId("webhook-delivery"),
          endpoint.id,
          endpoint.user_id,
          endpoint.workspace_id,
          event.id,
          event.type,
          now,
          now,
          now,
          endpoint.id,
          last.id,
          last.created_at,
        ),
      ),
    ]);
    if (cursor?.meta?.changes) queued += matching.length;
  }
  return queued;
};

const retryDelayMs = (attempt: number) => Math.min(60_000 * 2 ** (attempt - 1), 3_600_000);

/** At-least-once: receivers dedupe on `x-operloom-webhook-id`. */
export const deliverWebhooks = async (env: Env, at = new Date(), fetcher: typeof fetch = fetch) => {
  const now = at.toISOString();
  const queued = await fanOut(env, at);
  const due = await env.DB.prepare(
    `SELECT d.id, d.attempt_count, d.event_id, d.event_type, w.id AS endpoint_id, w.url,
            w.secret_version, e.agent_id, e.summary, e.target_type, e.target_id, e.data_json,
            e.created_at AS event_created_at, e.workspace_id
     FROM control_webhook_deliveries d
     JOIN control_webhook_endpoints w ON w.id = d.endpoint_id AND w.status = 'active'
     JOIN workspaces ws ON ws.id = w.workspace_id AND ws.status = 'active'
     JOIN memberships m ON m.user_id = w.user_id AND m.workspace_id = w.workspace_id
       AND m.status = 'active' AND m.role IN ('owner', 'admin')
     LEFT JOIN control_plane_events e ON e.id = d.event_id AND e.user_id = d.user_id
       AND e.workspace_id = d.workspace_id
     WHERE d.status = 'pending' AND d.next_attempt_at <= ?
       AND (d.lease_expires_at IS NULL OR d.lease_expires_at <= ?)
     ORDER BY d.next_attempt_at ASC LIMIT ?`,
  )
    .bind(now, now, deliveryBatch)
    .all<{
      id: string;
      attempt_count: number;
      event_id: string;
      event_type: string;
      endpoint_id: string;
      url: string;
      secret_version: number;
      agent_id: string | null;
      summary: string | null;
      target_type: string | null;
      target_id: string | null;
      data_json: string | null;
      event_created_at: string | null;
      workspace_id: string | null;
    }>();
  let delivered = 0;
  let failed = 0;
  for (const row of due.results) {
    const claimed = (await env.DB.prepare(
      `UPDATE control_webhook_deliveries SET lease_expires_at = ?
       WHERE id = ? AND status = 'pending' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
    )
      .bind(new Date(at.getTime() + leaseMs).toISOString(), row.id, now)
      .run()) as D1Result;
    if (!claimed.meta?.changes) continue;
    const attempt = row.attempt_count + 1;
    let statusCode: number | null = null;
    let errorCode: string | null = null;
    if (!row.event_created_at) {
      errorCode = "event_expired";
    } else {
      const body = JSON.stringify({
        id: row.event_id,
        type: row.event_type,
        createdAt: row.event_created_at,
        workspaceId: row.workspace_id,
        agentId: row.agent_id,
        summary: row.summary,
        target: row.target_type ? { type: row.target_type, id: row.target_id } : null,
        data: parseDataJson(row.data_json ?? "{}"),
      });
      const timestamp = Math.floor(at.getTime() / 1000);
      try {
        const response = await fetcher(row.url, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(deliveryTimeoutMs),
          headers: {
            "content-type": "application/json",
            "user-agent": "Operloom-Webhooks/1",
            "x-operloom-webhook-id": row.id,
            "x-operloom-event": row.event_type,
            "x-operloom-timestamp": String(timestamp),
            "x-operloom-signature": await signWebhookBody(
              await endpointSecret(env, {
                id: row.endpoint_id,
                secret_version: row.secret_version,
              }),
              timestamp,
              body,
            ),
          },
          body,
        });
        statusCode = response.status;
        if (!response.ok) errorCode = "receiver_rejected";
      } catch (error) {
        errorCode =
          error instanceof DOMException && error.name === "TimeoutError"
            ? "timeout"
            : "fetch_failed";
      }
    }
    const terminal = !errorCode || errorCode === "event_expired" || attempt >= maximumAttempts;
    const status = !errorCode ? "delivered" : terminal ? "failed" : "pending";
    await env.DB.prepare(
      `UPDATE control_webhook_deliveries
       SET status = ?, attempt_count = ?, next_attempt_at = ?, lease_expires_at = NULL,
           last_status_code = ?, last_error_code = ?, delivered_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
      .bind(
        status,
        attempt,
        status === "pending" ? new Date(at.getTime() + retryDelayMs(attempt)).toISOString() : now,
        statusCode,
        errorCode,
        status === "delivered" ? now : null,
        now,
        row.id,
      )
      .run();
    if (status === "delivered") delivered += 1;
    if (status === "failed") failed += 1;
  }
  await env.DB.prepare(
    `DELETE FROM control_webhook_deliveries
     WHERE status IN ('delivered', 'failed') AND updated_at < ?`,
  )
    .bind(new Date(at.getTime() - retentionMs).toISOString())
    .run();
  return { queued, attempted: due.results.length, delivered, failed };
};
