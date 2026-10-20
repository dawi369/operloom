import type { AgentIdentity, Env } from "./types";
import { appendControlPlaneEvent } from "./control-plane-events";

export const agentUpdateType = "agent.update";
/** A status line is a sentence, not a report; longer text belongs in an artifact. */
export const agentUpdateMaxChars = 280;
/** A loop that narrates every iteration stops being a status feed; later posts in the run are dropped. */
export const agentUpdatesPerRun = 60;

/** Event types the fleet timeline shows beside the agent's own updates. */
export const fleetTimelineTypes = [
  agentUpdateType,
  "run.started",
  "run.completed",
  "run.failed",
  "artifact.created",
  "approval.requested",
  "approval.approved",
  "approval.denied",
  "memory.proposed",
] as const;

export type AgentUpdate = {
  id: string;
  at: string;
  text: string;
  type: string;
  runId: string | null;
  data: Record<string, unknown>;
};

export const clampUpdateText = (text: string, max = agentUpdateMaxChars) => {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};

const countUpdatesForRun = async (env: Env, identity: AgentIdentity, runId: string) => {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM control_plane_events
     WHERE workspace_id = ? AND agent_id = ? AND type = ? AND target_type = 'run' AND target_id = ?`,
  )
    .bind(identity.scope.workspaceId, identity.agentId, agentUpdateType, runId)
    .first<{ count: number }>();
  return row?.count ?? 0;
};

/** Records one short line from the agent; returns false when the run has used its allowance. */
export const postAgentUpdate = async (
  env: Env,
  identity: AgentIdentity,
  input: { runId: string; text: string; data?: Record<string, unknown> },
) => {
  const text = clampUpdateText(input.text);
  if (!text) return false;
  const used = await countUpdatesForRun(env, identity, input.runId);
  if (used >= agentUpdatesPerRun) return false;
  await appendControlPlaneEvent(env, identity, {
    type: agentUpdateType,
    summary: text,
    targetType: "run",
    targetId: input.runId,
    data: { runId: input.runId, ...(input.data ?? {}) },
  });
  return true;
};

type EventRow = {
  id: string;
  agent_id: string;
  type: string;
  summary: string;
  target_type: string | null;
  target_id: string | null;
  data_json: string;
  created_at: string;
};

const toUpdate = (row: EventRow, chars: number): AgentUpdate => {
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.data_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  return {
    id: row.id,
    at: row.created_at,
    text: clampUpdateText(row.summary, chars),
    type: row.type,
    runId:
      row.target_type === "run"
        ? row.target_id
        : typeof data.runId === "string"
          ? data.runId
          : null,
    data,
  };
};

const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(",");

/** Latest `perAgent` agent-authored lines for every agent in the workspace, newest first. */
export const latestUpdatesByAgent = async (
  env: Env,
  workspaceId: string,
  input: { perAgent: number; chars: number },
) => {
  const map = new Map<string, AgentUpdate[]>();
  if (input.perAgent <= 0) return map;
  const rows = await env.DB.prepare(
    `SELECT id, agent_id, type, summary, target_type, target_id, data_json, created_at FROM (
       SELECT e.*, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY rowid DESC) AS rank
       FROM control_plane_events e
       WHERE workspace_id = ? AND type = ?
     ) WHERE rank <= ?`,
  )
    .bind(workspaceId, agentUpdateType, input.perAgent)
    .all<EventRow>();
  for (const row of rows.results) {
    const list = map.get(row.agent_id) ?? [];
    list.push(toUpdate(row, input.chars));
    map.set(row.agent_id, list);
  }
  return map;
};

/** One agent's timeline: its own updates plus run, artifact, approval and memory events; paged by id. */
export const listAgentTimeline = async (
  env: Env,
  workspaceId: string,
  agentId: string,
  input: { limit: number; before?: string; chars: number; types?: readonly string[] },
) => {
  const types = input.types?.length ? input.types : fleetTimelineTypes;
  const rows = await env.DB.prepare(
    `SELECT id, agent_id, type, summary, target_type, target_id, data_json, created_at
     FROM control_plane_events
     WHERE workspace_id = ? AND agent_id = ? AND type IN (${placeholders(types.length)})
       AND (? IS NULL OR rowid < (SELECT rowid FROM control_plane_events WHERE id = ? AND workspace_id = ?))
     ORDER BY rowid DESC
     LIMIT ?`,
  )
    .bind(
      workspaceId,
      agentId,
      ...types,
      input.before ?? null,
      input.before ?? null,
      workspaceId,
      input.limit + 1,
    )
    .all<EventRow>();
  const page = rows.results.slice(0, input.limit);
  return {
    updates: page.map((row) => toUpdate(row, input.chars)),
    nextBefore: rows.results.length > input.limit ? (page.at(-1)?.id ?? null) : null,
  };
};
