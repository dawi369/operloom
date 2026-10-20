import type { AgentIdentity, Env } from "./types";

/** When a provider operation that reaches a person may run; everything is optional. */
export type OutreachPolicy = {
  /** Sends per agent per calendar day in `window.timezone` (UTC when unset); counted from receipts. */
  dailyCap?: number;
  /** Local-time window in which sends are allowed, e.g. 09:00 to 20:00; wraps past midnight when end < start. */
  window?: { start: string; end: string; timezone?: string };
};

const timeOfDay = /^([01]\d|2[0-3]):[0-5]\d$/;

export const parseOutreachPolicy = (value: unknown): OutreachPolicy | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const policy: OutreachPolicy = {};
  if (raw.dailyCap !== undefined) {
    if (!Number.isInteger(raw.dailyCap) || Number(raw.dailyCap) < 0) return null;
    policy.dailyCap = Number(raw.dailyCap);
  }
  if (raw.window !== undefined) {
    const window = raw.window as Record<string, unknown> | null;
    if (
      !window ||
      typeof window.start !== "string" ||
      typeof window.end !== "string" ||
      !timeOfDay.test(window.start) ||
      !timeOfDay.test(window.end) ||
      (window.timezone !== undefined && typeof window.timezone !== "string")
    )
      return null;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: window.timezone ?? "UTC" });
    } catch {
      return null;
    }
    policy.window = {
      start: window.start,
      end: window.end,
      ...(window.timezone ? { timezone: window.timezone } : {}),
    };
  }
  return policy;
};

const localParts = (at: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
};

const toMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));

export const withinOutreachWindow = (policy: OutreachPolicy, at: Date) => {
  if (!policy.window) return true;
  const { minutes } = localParts(at, policy.window.timezone ?? "UTC");
  const start = toMinutes(policy.window.start);
  const end = toMinutes(policy.window.end);
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
};

/** The local calendar day the cap applies to, as a UTC range for the receipts query. */
export const outreachDayRange = (policy: OutreachPolicy, at: Date) => {
  const timeZone = policy.window?.timezone ?? "UTC";
  const { day } = localParts(at, timeZone);
  // Find the UTC instant where the local day starts by probing offsets around midnight UTC.
  const probe = new Date(`${day}T00:00:00.000Z`);
  for (const offsetMinutes of [
    -840, -720, -660, -600, -540, -480, -420, -360, -300, -240, -180, -120, -60, 0, 60, 120, 180,
    240, 300, 360, 420, 480, 540, 600, 660, 720, 780, 840,
  ]) {
    const candidate = new Date(probe.getTime() - offsetMinutes * 60_000);
    const local = localParts(candidate, timeZone);
    if (local.day === day && local.minutes === 0) {
      return {
        start: candidate.toISOString(),
        end: new Date(candidate.getTime() + 86_400_000).toISOString(),
      };
    }
  }
  return { start: probe.toISOString(), end: new Date(probe.getTime() + 86_400_000).toISOString() };
};

/** Receipts for one operation on one agent inside a UTC range; still-dispatching rows count so a burst cannot slip past. */
export const countOutreachSends = async (
  env: Env,
  identity: AgentIdentity,
  operationId: string,
  range: { start: string; end: string },
) => {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM control_provider_operations
     WHERE workspace_id = ? AND agent_id = ? AND operation_id = ?
       AND status IN ('dispatching','succeeded') AND created_at >= ? AND created_at < ?`,
  )
    .bind(identity.scope.workspaceId, identity.agentId, operationId, range.start, range.end)
    .first<{ count: number }>();
  return row?.count ?? 0;
};

/** Throws `outreach_window_closed` or `outreach_daily_cap_reached` before a provider is contacted. */
export const assertOutreachAllowed = async (
  env: Env,
  identity: AgentIdentity,
  operationId: string,
  policy: OutreachPolicy,
  now = new Date(),
  countSends: typeof countOutreachSends = countOutreachSends,
) => {
  if (!withinOutreachWindow(policy, now)) throw new Error("outreach_window_closed");
  if (policy.dailyCap === undefined) return;
  const sent = await countSends(env, identity, operationId, outreachDayRange(policy, now));
  if (sent >= policy.dailyCap) throw new Error("outreach_daily_cap_reached");
};
