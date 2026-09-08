import { resolveCredentialVault, type CredentialVault } from "./credential-vault";
import { pushEnabled } from "./feature-gates";
import { isRecord, json } from "./http";
import {
  createId,
  type AgentIdentity,
  type Env,
  type MessageBatch,
  type NotificationQueueMessage,
} from "./types";

const deliveryRetentionMs = 30 * 24 * 60 * 60 * 1_000;
const receiptDelaySeconds = 15 * 60;
const maxDeliveryAttempts = 4;

type DeviceRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  installation_id: string;
  platform: "ios" | "android";
  provider: "expo";
  vault_object_id: string;
  vault_version: string;
  status: "active" | "disabled" | "revoked";
  last_seen_at: string;
  app_version: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

type DeliveryRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  device_id: string;
  event_type: string;
  target_type: string;
  target_id: string;
  route: string;
  status: "queued" | "sent" | "delivered" | "failed" | "expired";
  attempt_count: number;
  provider_ticket_id: string | null;
  last_error_code: string | null;
  expires_at: string;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
};

export type NotificationPayload = {
  token: string;
  title: string;
  body: string;
  data: { route: string; recordId: string };
};

export type NotificationDeliveryResult =
  | { ok: true; ticketId: string }
  | { ok: false; code: string; invalidToken?: boolean; retryable: boolean };

export type NotificationReceiptResult =
  | { status: "delivered" }
  | { status: "pending" }
  | { status: "failed"; code: string; invalidToken?: boolean };

export type NotificationPort = {
  deliver(input: NotificationPayload): Promise<NotificationDeliveryResult>;
  receipt(ticketId: string): Promise<NotificationReceiptResult>;
};

const expoError = (value: unknown) => {
  if (!isRecord(value)) return { code: "provider_response_invalid", invalidToken: false };
  const details = isRecord(value.details) ? value.details : {};
  const code =
    typeof details.error === "string"
      ? details.error
      : typeof value.message === "string"
        ? value.message
        : "provider_delivery_failed";
  return { code, invalidToken: code === "DeviceNotRegistered" };
};

export const createExpoNotificationPort = (fetcher: typeof fetch = fetch): NotificationPort => ({
  async deliver(input) {
    const response = await fetcher("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        to: input.token,
        title: input.title,
        body: input.body,
        data: input.data,
        sound: "default",
        channelId: "workbench",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      return { ok: false, code: "provider_request_failed", retryable: response.status >= 500 };
    const payload = (await response.json().catch(() => null)) as unknown;
    const ticket = isRecord(payload) ? payload.data : null;
    if (!isRecord(ticket) || ticket.status !== "ok" || typeof ticket.id !== "string") {
      const error = expoError(ticket);
      return { ok: false, ...error, retryable: !error.invalidToken };
    }
    return { ok: true, ticketId: ticket.id };
  },
  async receipt(ticketId) {
    const response = await fetcher("https://exp.host/--/api/v2/push/getReceipts", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ ids: [ticketId] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { status: "pending" };
    const payload = (await response.json().catch(() => null)) as unknown;
    const receipts = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
    const receipt = receipts && isRecord(receipts[ticketId]) ? receipts[ticketId] : null;
    if (!receipt) return { status: "pending" };
    if (receipt.status === "ok") return { status: "delivered" };
    const error = expoError(receipt);
    return { status: "failed", ...error };
  },
});

export const createMemoryNotificationPort = (input?: {
  delivery?: NotificationDeliveryResult;
  receipt?: NotificationReceiptResult;
}): NotificationPort => ({
  deliver: async () => input?.delivery ?? { ok: true, ticketId: "memory-ticket" },
  receipt: async () => input?.receipt ?? { status: "delivered" },
});

export const resolveNotificationPort = (env: Env): NotificationPort => {
  if (env.WORKBENCH_E2E_MODE === "true") return createMemoryNotificationPort();
  return createExpoNotificationPort();
};

const deviceSummary = (row: DeviceRow) => ({
  id: row.id,
  installationId: row.installation_id,
  platform: row.platform,
  provider: row.provider,
  status: row.status,
  lastSeenAt: row.last_seen_at,
  appVersion: row.app_version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const selectDevice = (env: Env, identity: AgentIdentity, deviceId: string) =>
  env.DB.prepare(
    `SELECT id, user_id, workspace_id, installation_id, platform, provider, vault_object_id,
            vault_version, status, last_seen_at, app_version, created_at, updated_at, revoked_at
     FROM control_client_devices
     WHERE id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`,
  )
    .bind(deviceId, identity.scope.userId, identity.scope.workspaceId)
    .first<DeviceRow>();

export const handleListClientDevices = async (env: Env, identity: AgentIdentity) => {
  const rows = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, installation_id, platform, provider, vault_object_id,
            vault_version, status, last_seen_at, app_version, created_at, updated_at, revoked_at
     FROM control_client_devices WHERE user_id = ? AND workspace_id = ?
     ORDER BY updated_at DESC`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId)
    .all<DeviceRow>();
  return json({ ok: true, enabled: pushEnabled(env), devices: rows.results.map(deviceSummary) });
};

const validExpoToken = (token: string) => /^(Expo(nent)?PushToken)\[[A-Za-z0-9_-]+\]$/.test(token);

export const handleRegisterClientDevice = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
) => {
  if (!pushEnabled(env) || !env.NOTIFICATIONS)
    return json(
      { ok: false, code: "push_disabled", error: "Mobile notifications are disabled." },
      { status: 503 },
    );
  const body = await request.json().catch(() => null);
  if (
    !isRecord(body) ||
    typeof body.installationId !== "string" ||
    body.installationId.length < 16 ||
    body.installationId.length > 128 ||
    (body.platform !== "ios" && body.platform !== "android") ||
    typeof body.token !== "string" ||
    !validExpoToken(body.token) ||
    typeof body.appVersion !== "string" ||
    !body.appVersion.trim() ||
    body.appVersion.length > 64
  ) {
    return json(
      { ok: false, code: "invalid_device", error: "Device registration is invalid." },
      { status: 400 },
    );
  }
  const existing = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, installation_id, platform, provider, vault_object_id,
            vault_version, status, last_seen_at, app_version, created_at, updated_at, revoked_at
     FROM control_client_devices
     WHERE user_id = ? AND workspace_id = ? AND installation_id = ? LIMIT 1`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, body.installationId)
    .first<DeviceRow>();
  const pushToken = body.token;
  const vault = resolveCredentialVault(env);
  let reference = existing
    ? await vault
        .replace({
          id: existing.vault_object_id,
          version: existing.vault_version,
          value: pushToken,
        })
        .catch(() =>
          vault.create({
            context: { workspaceId: identity.scope.workspaceId },
            name: `push:${existing.id}`,
            value: pushToken,
          }),
        )
    : null;
  const deviceId = existing?.id ?? createId("cf-device");
  reference ??= await vault.create({
    context: { workspaceId: identity.scope.workspaceId },
    name: `push:${deviceId}`,
    value: pushToken,
  });
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO control_client_devices (
       id, user_id, workspace_id, installation_id, platform, provider, vault_object_id,
       vault_version, status, last_seen_at, app_version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'expo', ?, ?, 'active', ?, ?, ?, ?)
     ON CONFLICT(user_id, workspace_id, installation_id) DO UPDATE SET
       platform = excluded.platform, provider = excluded.provider,
       vault_object_id = excluded.vault_object_id, vault_version = excluded.vault_version,
       status = 'active', last_seen_at = excluded.last_seen_at, app_version = excluded.app_version,
       updated_at = excluded.updated_at, revoked_at = NULL`,
  )
    .bind(
      deviceId,
      identity.scope.userId,
      identity.scope.workspaceId,
      body.installationId,
      body.platform,
      reference.id,
      reference.version,
      timestamp,
      body.appVersion.trim(),
      existing?.created_at ?? timestamp,
      timestamp,
    )
    .run();
  const row = await selectDevice(env, identity, deviceId);
  return json({ ok: true, enabled: true, device: row ? deviceSummary(row) : undefined });
};

const revokeDevice = async (vault: CredentialVault, env: Env, row: DeviceRow, status: string) => {
  await vault.delete({ id: row.vault_object_id, version: row.vault_version });
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE control_client_devices SET status = ?, revoked_at = ?, updated_at = ?
     WHERE id = ? AND status = 'active'`,
  )
    .bind(status, timestamp, timestamp, row.id)
    .run();
};

export const handleRevokeClientDevice = async (
  env: Env,
  identity: AgentIdentity,
  deviceId: string,
) => {
  const row = await selectDevice(env, identity, deviceId);
  if (!row) return json({ ok: false, error: "Device not found." }, { status: 404 });
  if (row.status === "active") await revokeDevice(resolveCredentialVault(env), env, row, "revoked");
  return json({ ok: true, revoked: true });
};

export const handleNotificationPreferences = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
) => {
  if (request.method === "PUT") {
    const body = await request.json().catch(() => null);
    if (
      !isRecord(body) ||
      typeof body.approvalRequired !== "boolean" ||
      typeof body.terminalOutcomes !== "boolean"
    )
      return json(
        { ok: false, code: "invalid_preferences", error: "Notification preferences are invalid." },
        { status: 400 },
      );
    const timestamp = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO control_notification_preferences (
         id, user_id, workspace_id, approval_required, terminal_outcomes, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, workspace_id) DO UPDATE SET
         approval_required = excluded.approval_required,
         terminal_outcomes = excluded.terminal_outcomes,
         updated_at = excluded.updated_at`,
    )
      .bind(
        createId("cf-notification-preferences"),
        identity.scope.userId,
        identity.scope.workspaceId,
        body.approvalRequired ? 1 : 0,
        body.terminalOutcomes ? 1 : 0,
        timestamp,
        timestamp,
      )
      .run();
  }
  const row = await env.DB.prepare(
    `SELECT approval_required, terminal_outcomes, updated_at
     FROM control_notification_preferences WHERE user_id = ? AND workspace_id = ? LIMIT 1`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId)
    .first<{ approval_required: number; terminal_outcomes: number; updated_at: string }>();
  return json({
    ok: true,
    enabled: pushEnabled(env),
    preferences: {
      approvalRequired: row ? row.approval_required === 1 : true,
      terminalOutcomes: row ? row.terminal_outcomes === 1 : true,
      updatedAt: row?.updated_at,
    },
  });
};

type NotificationIntent = {
  category: "approval" | "terminal";
  eventType: string;
  targetType: string;
  targetId: string;
  route: string;
};

export const notificationIntentForEvent = (input: {
  type: string;
  targetType?: string;
  targetId?: string;
  data?: Record<string, unknown>;
}): NotificationIntent | null => {
  const targetId = input.targetId ?? "";
  if (!targetId) return null;
  if (input.type === "approval.requested" || input.type === "action.approval.requested") {
    return {
      category: "approval",
      eventType: input.type,
      targetType: input.targetType ?? "approvalRequest",
      targetId,
      route: "approvals",
    };
  }
  const actionStatus = typeof input.data?.status === "string" ? input.data.status : "";
  const terminalAction = [
    "executed",
    "failed",
    "outcome_unknown",
    "reconciled",
    "cancelled",
  ].includes(actionStatus);
  const terminal =
    /\.(completed|failed|cancelled)$/.test(input.type) ||
    input.type === "run.completed" ||
    input.type === "run.failed" ||
    (input.type === "action.updated" && terminalAction);
  if (!terminal) return null;
  return {
    category: "terminal",
    eventType: input.type,
    targetType: input.targetType ?? (input.type.startsWith("action") ? "actionProposal" : "run"),
    targetId,
    route: input.type.startsWith("action") ? "actions" : "history",
  };
};

export const enqueueNotificationEvent = async (
  env: Env,
  identity: AgentIdentity,
  event: Parameters<typeof notificationIntentForEvent>[0],
) => {
  if (!pushEnabled(env) || !env.NOTIFICATIONS) return { queued: 0 };
  const intent = notificationIntentForEvent(event);
  if (!intent) return { queued: 0 };
  const devices = await env.DB.prepare(
    `SELECT device.id FROM control_client_devices device
     LEFT JOIN control_notification_preferences preference
       ON preference.user_id = device.user_id AND preference.workspace_id = device.workspace_id
     WHERE device.user_id = ? AND device.workspace_id = ? AND device.status = 'active'
       AND CASE WHEN ? = 'approval' THEN COALESCE(preference.approval_required, 1)
                ELSE COALESCE(preference.terminal_outcomes, 1) END = 1`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, intent.category)
    .all<{ id: string }>();
  const timestamp = new Date().toISOString();
  const expiresAt = new Date(Date.now() + deliveryRetentionMs).toISOString();
  let queued = 0;
  for (const device of devices.results) {
    const deliveryId = createId("cf-notification");
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO control_notification_deliveries (
         id, user_id, workspace_id, device_id, event_type, target_type, target_id, route,
         status, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    )
      .bind(
        deliveryId,
        identity.scope.userId,
        identity.scope.workspaceId,
        device.id,
        intent.eventType,
        intent.targetType,
        intent.targetId,
        intent.route,
        expiresAt,
        timestamp,
        timestamp,
      )
      .run();
    if (((result as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) continue;
    try {
      await env.NOTIFICATIONS.send({ deliveryId, phase: "send" });
    } catch {
      await env.DB.prepare(
        `UPDATE control_notification_deliveries SET last_error_code = 'queue_enqueue_failed',
           updated_at = ? WHERE id = ? AND status = 'queued'`,
      )
        .bind(new Date().toISOString(), deliveryId)
        .run();
    }
    queued += 1;
  }
  return { queued };
};

const selectDelivery = (env: Env, deliveryId: string) =>
  env.DB.prepare(
    `SELECT id, user_id, workspace_id, device_id, event_type, target_type, target_id, route,
            status, attempt_count, provider_ticket_id, last_error_code, expires_at,
            delivered_at, created_at, updated_at
     FROM control_notification_deliveries WHERE id = ? LIMIT 1`,
  )
    .bind(deliveryId)
    .first<DeliveryRow>();

const disableInvalidDevice = async (env: Env, row: DeviceRow) =>
  revokeDevice(resolveCredentialVault(env), env, row, "disabled");

export const processNotificationQueue = async (
  batch: MessageBatch<NotificationQueueMessage>,
  env: Env,
  input?: { port?: NotificationPort },
) => {
  const port = input?.port ?? resolveNotificationPort(env);
  for (const message of batch.messages) {
    const delivery = await selectDelivery(env, message.body.deliveryId);
    if (!delivery || ["delivered", "failed", "expired"].includes(delivery.status)) {
      message.ack();
      continue;
    }
    const device = await env.DB.prepare(
      `SELECT id, user_id, workspace_id, installation_id, platform, provider, vault_object_id,
              vault_version, status, last_seen_at, app_version, created_at, updated_at, revoked_at
       FROM control_client_devices WHERE id = ? AND status = 'active' LIMIT 1`,
    )
      .bind(delivery.device_id)
      .first<DeviceRow>();
    if (!device || delivery.expires_at <= new Date().toISOString()) {
      await env.DB.prepare(
        `UPDATE control_notification_deliveries SET status = 'expired', updated_at = ? WHERE id = ?`,
      )
        .bind(new Date().toISOString(), delivery.id)
        .run();
      message.ack();
      continue;
    }
    try {
      if (message.body.phase === "receipt") {
        if (!delivery.provider_ticket_id) throw new Error("provider_ticket_missing");
        const receipt = await port.receipt(delivery.provider_ticket_id);
        if (receipt.status === "pending") {
          const timestamp = new Date().toISOString();
          if (delivery.attempt_count < maxDeliveryAttempts) {
            await env.DB.prepare(
              `UPDATE control_notification_deliveries SET attempt_count = attempt_count + 1,
                 updated_at = ? WHERE id = ? AND status = 'sent'`,
            )
              .bind(timestamp, delivery.id)
              .run();
            await env.NOTIFICATIONS?.send(
              { deliveryId: delivery.id, phase: "receipt" },
              { delaySeconds: receiptDelaySeconds },
            );
          } else {
            await env.DB.prepare(
              `UPDATE control_notification_deliveries SET status = 'failed',
                 last_error_code = 'receipt_timeout', updated_at = ? WHERE id = ?`,
            )
              .bind(timestamp, delivery.id)
              .run();
          }
          message.ack();
          continue;
        }
        const timestamp = new Date().toISOString();
        if (receipt.status === "delivered") {
          await env.DB.prepare(
            `UPDATE control_notification_deliveries SET status = 'delivered', delivered_at = ?,
               updated_at = ? WHERE id = ? AND status = 'sent'`,
          )
            .bind(timestamp, timestamp, delivery.id)
            .run();
        } else {
          if (receipt.invalidToken) await disableInvalidDevice(env, device);
          await env.DB.prepare(
            `UPDATE control_notification_deliveries SET status = 'failed', last_error_code = ?,
               updated_at = ? WHERE id = ?`,
          )
            .bind(receipt.code, timestamp, delivery.id)
            .run();
        }
        message.ack();
        continue;
      }
      const token = await resolveCredentialVault(env).read({
        id: device.vault_object_id,
        version: device.vault_version,
      });
      const approval = delivery.route === "approvals";
      const result = await port.deliver({
        token: token.value,
        title: approval ? "Action needed" : "Workbench update",
        body: approval ? "Open Operloom to review." : "Open Operloom for the latest result.",
        data: { route: delivery.route, recordId: delivery.target_id },
      });
      const timestamp = new Date().toISOString();
      if (result.ok) {
        await env.DB.prepare(
          `UPDATE control_notification_deliveries SET status = 'sent', attempt_count = attempt_count + 1,
             provider_ticket_id = ?, last_error_code = NULL, updated_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
          .bind(result.ticketId, timestamp, delivery.id)
          .run();
        await env.NOTIFICATIONS?.send(
          { deliveryId: delivery.id, phase: "receipt" },
          { delaySeconds: receiptDelaySeconds },
        );
        message.ack();
      } else if (result.invalidToken) {
        await disableInvalidDevice(env, device);
        await env.DB.prepare(
          `UPDATE control_notification_deliveries SET status = 'failed',
             attempt_count = attempt_count + 1, last_error_code = ?, updated_at = ? WHERE id = ?`,
        )
          .bind(result.code, timestamp, delivery.id)
          .run();
        message.ack();
      } else if (result.retryable && delivery.attempt_count + 1 < maxDeliveryAttempts) {
        await env.DB.prepare(
          `UPDATE control_notification_deliveries SET attempt_count = attempt_count + 1,
             last_error_code = ?, updated_at = ? WHERE id = ? AND status = 'queued'`,
        )
          .bind(result.code, timestamp, delivery.id)
          .run();
        message.retry({ delaySeconds: 30 * 2 ** delivery.attempt_count });
      } else {
        await env.DB.prepare(
          `UPDATE control_notification_deliveries SET status = 'failed',
             attempt_count = attempt_count + 1, last_error_code = ?, updated_at = ? WHERE id = ?`,
        )
          .bind(result.code, timestamp, delivery.id)
          .run();
        message.ack();
      }
    } catch {
      const timestamp = new Date().toISOString();
      const retryable = delivery.attempt_count + 1 < maxDeliveryAttempts;
      await env.DB.prepare(
        `UPDATE control_notification_deliveries SET attempt_count = attempt_count + 1,
           status = CASE WHEN ? THEN status ELSE 'failed' END,
           last_error_code = 'delivery_exception', updated_at = ? WHERE id = ?`,
      )
        .bind(retryable ? 1 : 0, timestamp, delivery.id)
        .run();
      if (retryable) message.retry({ delaySeconds: 30 * 2 ** delivery.attempt_count });
      else message.ack();
    }
  }
};

export const revokeWorkspaceDevices = async (env: Env, workspaceId: string) => {
  const rows = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, installation_id, platform, provider, vault_object_id,
            vault_version, status, last_seen_at, app_version, created_at, updated_at, revoked_at
     FROM control_client_devices WHERE workspace_id = ? AND status = 'active'`,
  )
    .bind(workspaceId)
    .all<DeviceRow>();
  let failed = 0;
  const vault = resolveCredentialVault(env);
  for (const row of rows.results) {
    try {
      await revokeDevice(vault, env, row, "revoked");
    } catch {
      failed += 1;
    }
  }
  return { revoked: rows.results.length - failed, failed };
};

export const sweepNotificationDeliveries = async (env: Env, now = new Date()) => {
  const timestamp = now.toISOString();
  const stranded = env.NOTIFICATIONS
    ? await env.DB.prepare(
        `SELECT id FROM control_notification_deliveries
         WHERE status = 'queued' AND last_error_code = 'queue_enqueue_failed' AND expires_at > ?
         ORDER BY updated_at ASC LIMIT 100`,
      )
        .bind(timestamp)
        .all<{ id: string }>()
    : { results: [] as Array<{ id: string }> };
  let requeued = 0;
  for (const delivery of stranded.results) {
    try {
      await env.NOTIFICATIONS?.send({ deliveryId: delivery.id, phase: "send" });
      await env.DB.prepare(
        `UPDATE control_notification_deliveries SET last_error_code = NULL, updated_at = ?
         WHERE id = ? AND status = 'queued' AND last_error_code = 'queue_enqueue_failed'`,
      )
        .bind(timestamp, delivery.id)
        .run();
      requeued += 1;
    } catch {
      // Leave the durable outbox marker for the next bounded scheduled sweep.
    }
  }
  const expired = await env.DB.prepare(
    `UPDATE control_notification_deliveries SET status = 'expired', updated_at = ?
     WHERE status IN ('queued', 'sent') AND expires_at <= ?`,
  )
    .bind(timestamp, timestamp)
    .run();
  const deleted = await env.DB.prepare(
    `DELETE FROM control_notification_deliveries WHERE expires_at <= ?`,
  )
    .bind(timestamp)
    .run();
  return {
    requeued,
    expired: (expired as { meta?: { changes?: number } }).meta?.changes ?? 0,
    deleted: (deleted as { meta?: { changes?: number } }).meta?.changes ?? 0,
  };
};
