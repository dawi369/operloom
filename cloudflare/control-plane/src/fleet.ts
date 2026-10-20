import type { AgentIdentity, Env } from "./types";
import { selectWorkspaceAgents } from "./authz-store";
import { json } from "./http";
import { latestUpdatesByAgent, listAgentTimeline, type AgentUpdate } from "./agent-updates";

export type FleetAgentStatus = "idle" | "running" | "waiting_approval" | "erroring" | "paused";

export type FleetAgent = {
  id: string;
  name: string;
  status: FleetAgentStatus;
  effectTarget: "simulation" | "external";
  isDefault: boolean;
  currentRun: {
    id: string;
    stage: string | null;
    startedAt: string;
    workflowType: string | null;
  } | null;
  lastRun: {
    id: string;
    status: string;
    finishedAt: string;
    summary: string | null;
    workflowType: string | null;
  } | null;
  openApprovals: number;
  runsToday: number;
  failedToday: number;
  tokensToday: number;
  triggers: {
    enabled: number;
    paused: number;
    nextTickAt: string | null;
    lastTickAt: string | null;
  };
  lastError: { runId: string; at: string; summary: string | null } | null;
  /** The agent's own latest status lines, newest first; length and count follow the request. */
  updates: AgentUpdate[];
};

export type FleetOptions = { updatesPerAgent: number; updateChars: number };
export const defaultFleetOptions: FleetOptions = { updatesPerAgent: 3, updateChars: 140 };
const clampInt = (value: string | null, fallback: number, min: number, max: number) => {
  const parsed = value === null ? Number.NaN : Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};
export const fleetOptionsFromUrl = (url: URL): FleetOptions => ({
  updatesPerAgent: clampInt(
    url.searchParams.get("updates"),
    defaultFleetOptions.updatesPerAgent,
    0,
    20,
  ),
  updateChars: clampInt(url.searchParams.get("chars"), defaultFleetOptions.updateChars, 40, 280),
});

const activeRunStatuses = ["queued", "running", "waiting", "interrupted", "blocked"] as const;
const inList = (values: readonly string[]) => values.map(() => "?").join(",");

const byAgent = <T extends { agent_id: string }>(rows: readonly T[]) => {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.agent_id);
    if (list) list.push(row);
    else map.set(row.agent_id, [row]);
  }
  return map;
};

type RunRow = {
  agent_id: string;
  id: string;
  status: string;
  stage: string | null;
  created_at: string;
  completed_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  updated_at: string;
  summary: string | null;
  workflow_type: string | null;
};

const finishedAt = (row: RunRow) =>
  row.completed_at ?? row.failed_at ?? row.cancelled_at ?? row.updated_at;

/** One row per agent: what it is doing, what it did last, what waits on a human, and when it ticks next. */
export const fleetSnapshot = async (
  env: Env,
  identity: AgentIdentity,
  now = new Date(),
  options: FleetOptions = defaultFleetOptions,
): Promise<FleetAgent[]> => {
  const workspaceId = identity.scope.workspaceId;
  const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const [agents, active, recent, approvals, today, triggers, usage, updates] = await Promise.all([
    selectWorkspaceAgents(env, workspaceId),
    env.DB.prepare(
      `SELECT r.agent_id, r.id, r.status, r.stage, r.created_at, r.completed_at, r.failed_at, r.cancelled_at,
              r.updated_at, json_extract(r.data_json, '$.summary') AS summary, i.type AS workflow_type
       FROM control_runs r
       LEFT JOIN control_workflow_intents i ON i.id = r.workflow_intent_id
       WHERE r.workspace_id = ? AND r.status IN (${inList(activeRunStatuses)})
       ORDER BY r.created_at DESC`,
    )
      .bind(workspaceId, ...activeRunStatuses)
      .all<RunRow>(),
    // Newest finished run per agent; the window keeps this bounded on busy workspaces.
    env.DB.prepare(
      `SELECT r.agent_id, r.id, r.status, r.stage, r.created_at, r.completed_at, r.failed_at, r.cancelled_at,
              r.updated_at, json_extract(r.data_json, '$.summary') AS summary, i.type AS workflow_type
       FROM control_runs r
       LEFT JOIN control_workflow_intents i ON i.id = r.workflow_intent_id
       WHERE r.workspace_id = ? AND r.status IN ('completed','failed','cancelled')
       ORDER BY r.updated_at DESC
       LIMIT 200`,
    )
      .bind(workspaceId)
      .all<RunRow>(),
    env.DB.prepare(
      `SELECT agent_id, COUNT(*) AS count FROM control_approval_requests
       WHERE workspace_id = ? AND status = 'requested' GROUP BY agent_id`,
    )
      .bind(workspaceId)
      .all<{ agent_id: string; count: number }>(),
    env.DB.prepare(
      `SELECT agent_id, COUNT(*) AS runs, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM control_runs WHERE workspace_id = ? AND created_at >= ? GROUP BY agent_id`,
    )
      .bind(workspaceId, dayStart)
      .all<{ agent_id: string; runs: number; failed: number }>(),
    env.DB.prepare(
      `SELECT agent_id, status, next_trigger_at, last_triggered_at FROM control_triggers
       WHERE workspace_id = ? AND status IN ('enabled','paused')`,
    )
      .bind(workspaceId)
      .all<{
        agent_id: string;
        status: string;
        next_trigger_at: string | null;
        last_triggered_at: string | null;
      }>(),
    env.DB.prepare(
      `SELECT agent_id, SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS tokens
       FROM control_resource_reservations
       WHERE workspace_id = ? AND day = ? AND status = 'settled' GROUP BY agent_id`,
    )
      .bind(workspaceId, now.toISOString().slice(0, 10))
      .all<{ agent_id: string; tokens: number | null }>(),
    latestUpdatesByAgent(env, workspaceId, {
      perAgent: options.updatesPerAgent,
      chars: options.updateChars,
    }),
  ]);

  const activeByAgent = byAgent(active.results);
  const recentByAgent = byAgent(recent.results);
  const approvalsByAgent = new Map(approvals.results.map((row) => [row.agent_id, row.count]));
  const todayByAgent = new Map(today.results.map((row) => [row.agent_id, row]));
  const triggersByAgent = byAgent(triggers.results);
  const tokensByAgent = new Map(usage.results.map((row) => [row.agent_id, row.tokens ?? 0]));

  return agents.results.map((agent) => {
    const current = activeByAgent.get(agent.id)?.[0] ?? null;
    const history = recentByAgent.get(agent.id) ?? [];
    const last = history[0] ?? null;
    const lastFailed = history.find((row) => row.status === "failed") ?? null;
    const openApprovals = approvalsByAgent.get(agent.id) ?? 0;
    const agentTriggers = triggersByAgent.get(agent.id) ?? [];
    const nextTicks = agentTriggers
      .filter((row) => row.status === "enabled" && row.next_trigger_at)
      .map((row) => row.next_trigger_at!)
      .sort();
    const lastTicks = agentTriggers
      .map((row) => row.last_triggered_at)
      .filter((value): value is string => Boolean(value))
      .sort();
    const status: FleetAgentStatus =
      agent.status !== "active"
        ? "paused"
        : openApprovals > 0
          ? "waiting_approval"
          : current
            ? "running"
            : last?.status === "failed"
              ? "erroring"
              : "idle";
    const counts = todayByAgent.get(agent.id);
    return {
      id: agent.id,
      name: agent.name,
      status,
      effectTarget: agent.effect_target ?? "simulation",
      isDefault: agent.is_default === 1,
      currentRun: current
        ? {
            id: current.id,
            stage: current.stage,
            startedAt: current.created_at,
            workflowType: current.workflow_type,
          }
        : null,
      lastRun: last
        ? {
            id: last.id,
            status: last.status,
            finishedAt: finishedAt(last),
            summary: last.summary,
            workflowType: last.workflow_type,
          }
        : null,
      openApprovals,
      runsToday: counts?.runs ?? 0,
      failedToday: counts?.failed ?? 0,
      tokensToday: tokensByAgent.get(agent.id) ?? 0,
      triggers: {
        enabled: agentTriggers.filter((row) => row.status === "enabled").length,
        paused: agentTriggers.filter((row) => row.status === "paused").length,
        nextTickAt: nextTicks[0] ?? null,
        lastTickAt: lastTicks.at(-1) ?? null,
      },
      lastError: lastFailed
        ? { runId: lastFailed.id, at: finishedAt(lastFailed), summary: lastFailed.summary }
        : null,
      updates: updates.get(agent.id) ?? [],
    };
  });
};

export const handleFleet = async (request: Request, env: Env, identity: AgentIdentity) => {
  const url = new URL(request.url);
  const match = url.pathname.match(/\/workbench\/fleet\/([^/]+)$/);
  if (match) {
    const agentId = decodeURIComponent(match[1]!);
    const agents = await selectWorkspaceAgents(env, identity.scope.workspaceId);
    const agent = agents.results.find((row) => row.id === agentId);
    if (!agent) return json({ ok: false, error: "Agent not found" }, { status: 404 });
    const page = await listAgentTimeline(env, identity.scope.workspaceId, agentId, {
      limit: clampInt(url.searchParams.get("limit"), 50, 1, 200),
      before: url.searchParams.get("before") ?? undefined,
      chars: clampInt(url.searchParams.get("chars"), 280, 40, 280),
    });
    return json({ ok: true, agent: { id: agent.id, name: agent.name }, ...page });
  }
  return json({
    ok: true,
    generatedAt: new Date().toISOString(),
    agents: await fleetSnapshot(env, identity, new Date(), fleetOptionsFromUrl(url)),
  });
};
