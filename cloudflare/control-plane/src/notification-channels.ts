import type { NotificationChannel, NotificationSeverity } from "@operloom/agent-sdk/control-plane";
import { EntitlementError, requireEntitlement } from "./billing-plans";
import { resolveCredentialVault } from "./credential-vault";
import { isRecord, json } from "./http";
import { signWebhookBody } from "./webhooks";
import { createId, type AgentIdentity, type Env } from "./types";

export const notificationChannels = [
  "push",
  "email",
  "sms",
] as const satisfies readonly NotificationChannel[];
export const notificationSeverities = [
  "info",
  "action",
  "alert",
] as const satisfies readonly NotificationSeverity[];
export const isNotificationChannel = (value: unknown): value is NotificationChannel =>
  typeof value === "string" && (notificationChannels as readonly string[]).includes(value);

export type ChannelMessage = {
  channel: "email" | "sms";
  address: string;
  title: string;
  body: string;
  data: { eventType: string; targetType: string; targetId: string; route: string };
};
export type ChannelSendResult =
  | { ok: true; ticketId: string }
  | { ok: false; code: string; retryable: boolean };
export type ChannelTransport = { send(message: ChannelMessage): Promise<ChannelSendResult> };

/** Local and conformance transport: the delivery row is the record; nothing leaves the Worker. */
export const createRecordedChannelTransport = (
  sent: ChannelMessage[] = [],
): ChannelTransport & {
  sent: ChannelMessage[];
} => ({
  sent,
  async send(message) {
    sent.push(message);
    return { ok: true, ticketId: `recorded:${createId("cf-recorded")}` };
  },
});

/**
 * Hosted transport: one platform-held relay receives signed `{channel, to, title, body}`
 * requests and forwards them to the configured email/SMS vendor. Credentials stay
 * with the relay; the Worker only holds the relay secret.
 */
export const createRelayChannelTransport = (
  url: string,
  secret: string,
  fetcher: typeof fetch = fetch,
): ChannelTransport => ({
  async send(message) {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      channel: message.channel,
      to: message.address,
      title: message.title,
      body: message.body,
      data: message.data,
    });
    try {
      const response = await fetcher(url, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "x-operloom-timestamp": String(timestamp),
          "x-operloom-signature": await signWebhookBody(secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const parsed = (await response.json().catch(() => null)) as { id?: unknown } | null;
        return {
          ok: true,
          ticketId: typeof parsed?.id === "string" ? parsed.id.slice(0, 200) : `relay:${timestamp}`,
        };
      }
      return {
        ok: false,
        code: `relay_http_${response.status}`,
        retryable: response.status >= 500,
      };
    } catch {
      return { ok: false, code: "relay_unreachable", retryable: true };
    }
  },
});

export const resolveChannelTransport = (env: Env): ChannelTransport => {
  const url = env.OPERLOOM_NOTIFICATION_RELAY_URL?.trim();
  const secret = env.OPERLOOM_NOTIFICATION_RELAY_SECRET?.trim();
  if (env.OPERLOOM_E2E_MODE !== "true" && url && secret) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("notification_relay_not_https");
    return createRelayChannelTransport(url, secret);
  }
  return createRecordedChannelTransport();
};

type PreferenceRow = {
  channel: NotificationChannel;
  event_type: string;
  enabled: number;
  quiet_start: number | null;
  quiet_end: number | null;
  digest_hour: number | null;
  updated_at: string;
};

const preferenceSummary = (row: PreferenceRow) => ({
  channel: row.channel,
  eventType: row.event_type,
  enabled: row.enabled === 1,
  quietStart: row.quiet_start,
  quietEnd: row.quiet_end,
  digestHour: row.digest_hour,
  updatedAt: row.updated_at,
});

export const listChannelPreferences = async (env: Env, identity: AgentIdentity) =>
  (
    await env.DB.prepare(
      `SELECT channel, event_type, enabled, quiet_start, quiet_end, digest_hour, updated_at
       FROM control_notification_channel_preferences
       WHERE user_id = ? AND workspace_id = ? ORDER BY channel, event_type`,
    )
      .bind(identity.scope.userId, identity.scope.workspaceId)
      .all<PreferenceRow>()
  ).results;

/** The event-type row wins over the channel's `*` default. */
export const resolveChannelPreference = (
  rows: readonly PreferenceRow[],
  channel: NotificationChannel,
  eventType: string,
) =>
  rows.find((row) => row.channel === channel && row.event_type === eventType) ??
  rows.find((row) => row.channel === channel && row.event_type === "*") ??
  null;

/** Hours are UTC; a window may wrap midnight. */
export const inQuietHours = (
  preference: Pick<PreferenceRow, "quiet_start" | "quiet_end"> | null,
  now: Date,
) => {
  if (!preference || preference.quiet_start === null || preference.quiet_end === null) return false;
  const hour = now.getUTCHours();
  const { quiet_start: start, quiet_end: end } = preference;
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
};

export const quietHoursEnd = (preference: Pick<PreferenceRow, "quiet_end">, now: Date) => {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(preference.quiet_end ?? 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
};

const hour = (value: unknown) =>
  value === null || value === undefined
    ? null
    : Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 23
      ? Number(value)
      : undefined;

export const handleChannelPreferences = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
) => {
  if (request.method === "PUT") {
    const body = await request.json().catch(() => null);
    const quietStart = hour(isRecord(body) ? body.quietStart : null);
    const quietEnd = hour(isRecord(body) ? body.quietEnd : null);
    const digestHour = hour(isRecord(body) ? body.digestHour : null);
    const eventType = isRecord(body) && body.eventType !== undefined ? body.eventType : "*";
    if (
      !isRecord(body) ||
      !isNotificationChannel(body.channel) ||
      typeof body.enabled !== "boolean" ||
      typeof eventType !== "string" ||
      !/^(\*|[a-z][a-z0-9_.-]{2,63})$/.test(eventType) ||
      quietStart === undefined ||
      quietEnd === undefined ||
      digestHour === undefined ||
      (quietStart === null) !== (quietEnd === null)
    )
      return json(
        { ok: false, code: "invalid_preferences", error: "Notification preferences are invalid." },
        { status: 400 },
      );
    const timestamp = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO control_notification_channel_preferences (
         id, user_id, workspace_id, channel, event_type, enabled, quiet_start, quiet_end, digest_hour,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, workspace_id, channel, event_type) DO UPDATE SET
         enabled = excluded.enabled, quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end,
         digest_hour = excluded.digest_hour, updated_at = excluded.updated_at`,
    )
      .bind(
        createId("cf-channel-preference"),
        identity.scope.userId,
        identity.scope.workspaceId,
        body.channel,
        eventType,
        body.enabled ? 1 : 0,
        quietStart,
        quietEnd,
        digestHour,
        timestamp,
        timestamp,
      )
      .run();
  }
  const rows = await listChannelPreferences(env, identity);
  return json({ ok: true, preferences: rows.map(preferenceSummary) });
};

const validAddress = (channel: "email" | "sms", value: string) =>
  channel === "email"
    ? /^[^\s@]{1,64}@[^\s@]{1,255}$/.test(value)
    : /^\+[1-9][0-9]{6,14}$/.test(value);

/** A user-entered email override or SMS number, held in the vault like a device token. */
export const handleNotificationAddress = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
) => {
  const body = await request.json().catch(() => null);
  if (
    !isRecord(body) ||
    (body.channel !== "email" && body.channel !== "sms") ||
    typeof body.address !== "string" ||
    !validAddress(body.channel, body.address.trim())
  )
    return json(
      { ok: false, code: "invalid_address", error: "Notification address is invalid." },
      { status: 400 },
    );
  const channel = body.channel;
  try {
    await requireEntitlement(env, identity.scope.workspaceId, "notifications.relay");
  } catch (error) {
    if (error instanceof EntitlementError)
      return json({ ok: false, code: error.code, error: error.message }, { status: error.status });
    throw error;
  }
  const vault = resolveCredentialVault(env);
  const existing = await env.DB.prepare(
    `SELECT id, vault_object_id, vault_version FROM control_notification_addresses
     WHERE user_id = ? AND workspace_id = ? AND channel = ? LIMIT 1`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, channel)
    .first<{ id: string; vault_object_id: string; vault_version: string }>();
  const stored = await vault.create({
    context: { workspaceId: identity.scope.workspaceId },
    name: `notification-address-${channel}`,
    value: body.address.trim(),
  });
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO control_notification_addresses (
       id, user_id, workspace_id, channel, vault_object_id, vault_version, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(user_id, workspace_id, channel) DO UPDATE SET
       vault_object_id = excluded.vault_object_id, vault_version = excluded.vault_version,
       status = 'active', updated_at = excluded.updated_at`,
  )
    .bind(
      createId("cf-notification-address"),
      identity.scope.userId,
      identity.scope.workspaceId,
      channel,
      stored.id,
      stored.version,
      timestamp,
      timestamp,
    )
    .run();
  if (existing)
    await vault
      .delete({ id: existing.vault_object_id, version: existing.vault_version })
      .catch(() => undefined);
  return json({ ok: true, channel, status: "active", updatedAt: timestamp });
};

/** Email falls back to the signed-in profile; SMS needs a stored number. Returns an opaque reference plus the value. */
export const resolveChannelAddress = async (
  env: Env,
  scope: { userId: string; workspaceId: string },
  channel: "email" | "sms",
): Promise<{ ref: string; address: string } | null> => {
  const stored = await env.DB.prepare(
    `SELECT vault_object_id, vault_version FROM control_notification_addresses
     WHERE user_id = ? AND workspace_id = ? AND channel = ? AND status = 'active' LIMIT 1`,
  )
    .bind(scope.userId, scope.workspaceId, channel)
    .first<{ vault_object_id: string; vault_version: string }>();
  if (stored) {
    const value = await resolveCredentialVault(env).read({
      id: stored.vault_object_id,
      version: stored.vault_version,
    });
    return { ref: `vault:${stored.vault_object_id}`, address: value.value };
  }
  if (channel !== "email") return null;
  const user = await env.DB.prepare(
    `SELECT email FROM users WHERE id = ? AND status = 'active' LIMIT 1`,
  )
    .bind(scope.userId)
    .first<{ email: string | null }>();
  return user?.email ? { ref: "profile:email", address: user.email } : null;
};
