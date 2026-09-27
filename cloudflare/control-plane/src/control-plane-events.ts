import { parseDataJson } from "./http";
import { createId, toJson, type AgentIdentity, type ControlPlaneEventRow, type Env } from "./types";
import { enqueueNotificationEvent } from "./notification-delivery";

const defaultLimit = 50;
const maxLimit = 100;
const streamBatchLimit = 25;
const streamWindowMs = 25_000;
const streamPollIntervalMs = 500;
const streamHeartbeatMs = 5_000;

const readLimit = (url: URL) => {
  const requested = Number(url.searchParams.get("limit") ?? defaultLimit);
  if (!Number.isFinite(requested)) return defaultLimit;
  return Math.min(Math.max(Math.trunc(requested), 1), maxLimit);
};

export const appendControlPlaneEvent = async (
  env: Env,
  identity: AgentIdentity,
  input: {
    type: string;
    summary: string;
    targetType?: string;
    targetId?: string;
    data?: Record<string, unknown>;
  },
) => {
  const timestamp = new Date().toISOString();
  const eventId = createId("cf-event");
  await env.DB.prepare(
    `INSERT INTO control_plane_events (
       id, user_id, workspace_id, agent_id, type, summary, target_type, target_id,
       data_json, created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      eventId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      input.type,
      input.summary,
      input.targetType ?? null,
      input.targetId ?? null,
      toJson(input.data ?? {}),
      timestamp,
    )
    .run();
  await enqueueNotificationEvent(env, identity, input);
  return eventId;
};

const listLatestEvents = async (env: Env, identity: AgentIdentity, limit: number) => {
  const events = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, type, summary, target_type, target_id,
            data_json, created_at
     FROM control_plane_events
     WHERE user_id = ? AND workspace_id = ?
     ORDER BY rowid DESC
     LIMIT ?`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, limit)
    .all<ControlPlaneEventRow>();
  return events.results;
};

const listEventsAfter = async (
  env: Env,
  identity: AgentIdentity,
  afterEventId: string,
  limit: number,
) => {
  const cursor = await env.DB.prepare(
    `SELECT rowid AS cursor
     FROM control_plane_events
     WHERE user_id = ? AND workspace_id = ? AND id = ?
     LIMIT 1`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, afterEventId)
    .first<{ cursor: number }>();

  if (!cursor) return [];

  const events = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, type, summary, target_type, target_id,
            data_json, created_at
     FROM control_plane_events
     WHERE user_id = ? AND workspace_id = ? AND rowid > ?
     ORDER BY rowid ASC
     LIMIT ?`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, cursor.cursor, limit)
    .all<ControlPlaneEventRow>();
  return events.results;
};

const latestEventCursor = async (env: Env, identity: AgentIdentity) => {
  const cursor = await env.DB.prepare(
    `SELECT rowid AS cursor
     FROM control_plane_events
     WHERE user_id = ? AND workspace_id = ?
     ORDER BY rowid DESC
     LIMIT 1`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId)
    .first<{ cursor: number }>();

  return cursor?.cursor ?? 0;
};

const eventCursor = async (env: Env, identity: AgentIdentity, eventId: string) => {
  const cursor = await env.DB.prepare(
    `SELECT rowid AS cursor
     FROM control_plane_events
     WHERE user_id = ? AND workspace_id = ? AND id = ?
     LIMIT 1`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, eventId)
    .first<{ cursor: number }>();

  return cursor?.cursor ?? null;
};

const listEventsAfterCursor = async (
  env: Env,
  identity: AgentIdentity,
  cursor: number,
  limit: number,
) => {
  const events = await env.DB.prepare(
    `SELECT rowid AS cursor, id, user_id, workspace_id, agent_id, type, summary,
            target_type, target_id, data_json, created_at
     FROM control_plane_events
     WHERE user_id = ? AND workspace_id = ? AND rowid > ?
     ORDER BY rowid ASC
     LIMIT ?`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, cursor, limit)
    .all<ControlPlaneEventRow & { cursor: number }>();

  return events.results;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const readControlEventReplayAfter = (url: URL, headers?: Headers) => {
  const after = url.searchParams.get("after")?.trim();
  if (after) return after;
  const lastEventId = headers?.get("Last-Event-ID")?.trim();
  return lastEventId || undefined;
};

const encodeSse = (event: string, data: unknown, id?: string) =>
  `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const encodeHeartbeat = () => `: heartbeat ${new Date().toISOString()}\n\n`;

export const toControlPlaneEventSnapshot = (row: ControlPlaneEventRow) => ({
  id: row.id,
  scope: {
    userId: row.user_id,
    workspaceId: row.workspace_id,
  },
  agentId: row.agent_id,
  type: row.type,
  summary: row.summary,
  targetType: row.target_type ?? undefined,
  targetId: row.target_id ?? undefined,
  data: parseDataJson(row.data_json),
  createdAt: row.created_at,
});

export const handleLatestControlPlaneEvents = async (
  env: Env,
  identity: AgentIdentity,
  url: URL,
) => {
  const events = await listLatestEvents(env, identity, readLimit(url));
  return {
    ok: true,
    events: events.map(toControlPlaneEventSnapshot),
  };
};

export const handleControlPlaneEvents = async (env: Env, identity: AgentIdentity, url: URL) => {
  const limit = readLimit(url);
  const after = readControlEventReplayAfter(url);
  if (after && (await eventCursor(env, identity, after)) === null)
    return { ok: true, events: [], resetRequired: true, reason: "cursor_expired" };
  const events = after
    ? await listEventsAfter(env, identity, after, limit)
    : await listLatestEvents(env, identity, limit);

  return {
    ok: true,
    events: events.map(toControlPlaneEventSnapshot),
  };
};

export const handleControlPlaneEventStream = async (
  env: Env,
  identity: AgentIdentity,
  request: Request,
) => {
  const encoder = new TextEncoder();
  const url = new URL(request.url);
  const after = readControlEventReplayAfter(url, request.headers);

  const afterCursor = after ? await eventCursor(env, identity, after) : undefined;
  if (after && afterCursor === null)
    return new Response(
      encodeSse("reset", { reason: "cursor_expired", action: "fetch_canonical_state" }),
      {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    async start(controller) {
      let cursor = after
        ? ((await eventCursor(env, identity, after)) ?? (await latestEventCursor(env, identity)))
        : await latestEventCursor(env, identity);
      let lastHeartbeatAt = 0;
      const startedAt = Date.now();

      try {
        while (!cancelled && !request.signal.aborted && Date.now() - startedAt < streamWindowMs) {
          const events = await listEventsAfterCursor(env, identity, cursor, streamBatchLimit);

          if (events.length > 0) {
            for (const event of events) {
              cursor = event.cursor;
              controller.enqueue(
                encoder.encode(
                  encodeSse("control-plane-event", toControlPlaneEventSnapshot(event), event.id),
                ),
              );
            }
            continue;
          }

          const now = Date.now();
          if (now - lastHeartbeatAt >= streamHeartbeatMs) {
            controller.enqueue(encoder.encode(encodeHeartbeat()));
            lastHeartbeatAt = now;
          }

          await sleep(streamPollIntervalMs);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown event stream failure";
        if (!cancelled)
          controller.enqueue(encoder.encode(encodeSse("control-plane-error", { error: message })));
      } finally {
        if (!cancelled) controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
};
