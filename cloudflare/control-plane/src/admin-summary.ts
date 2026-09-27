import { toAgentSummary } from "./agent-records";
import {
  listLatestArtifacts,
  listLatestToolCalls,
  resolveToolSummaries,
} from "./runtime-tool-catalog";
import { getChatRuntimeSummary } from "./chat-runtime-summary";
import { handleLatestControlPlaneEvents } from "./control-plane-events";
import { getControlRunSnapshot, readLatestControlRun } from "./control-run-store";
import { json, parseDataJson, parseJson } from "./http";
import { getLatestRuntimeTraceSnapshot, listRuntimeTraceSummaries } from "./runtime-traces";
import {
  readAdminSummaryProjection,
  type AdminSummaryProjection,
} from "../../../lib/workbench/admin-summary-projection";
import {
  selectAgent,
  selectAccountWorkspacesForUser,
  selectDefaultAgent,
  selectMembership,
  selectUser,
  selectWorkspace,
  selectWorkspaceAgents,
} from "./authz-store";
import type {
  AgentIdentity,
  ControlPlaneEventRow,
  ControlRunRow,
  Env,
  TenantScope,
  WorkspaceRow,
} from "./types";

const authModeHeader = "x-operloom-auth-mode";
const workspaceSourceHeader = "x-operloom-workspace-source";
const membershipRoleHeader = "x-operloom-membership-role";
const membershipRolesHeader = "x-operloom-membership-roles";
const membershipPermissionsHeader = "x-operloom-membership-permissions";
const membershipStatusHeader = "x-operloom-membership-status";
const compactEventLimit = 6;
const drawerEventLimit = 12;

type AdminSummaryDiagnostics = {
  projection: AdminSummaryProjection;
  totalDurationMs: number;
  sections: Record<string, { durationMs: number; count?: number }>;
};

const readOptionalHeader = (request: Request, name: string) =>
  request.headers.get(name)?.trim() || undefined;

const parseStringArray = (raw: string) => {
  const parsed = parseJson(raw || "[]");
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
};

const externalMembershipSummary = (request: Request) => {
  const role = readOptionalHeader(request, membershipRoleHeader);
  const roles = parseStringArray(readOptionalHeader(request, membershipRolesHeader) ?? "[]");
  const permissions = parseStringArray(
    readOptionalHeader(request, membershipPermissionsHeader) ?? "[]",
  );
  const status = readOptionalHeader(request, membershipStatusHeader);

  if (!role && roles.length === 0 && permissions.length === 0 && !status) return null;

  return {
    source: "workos-headers",
    role: role ?? null,
    status: status ?? null,
    roles,
    permissions,
  };
};

const toWorkspaceSummary = (row: WorkspaceRow, activeWorkspaceId: string) => ({
  id: row.id,
  name: row.name,
  status: row.status,
  isDefault: row.is_default === 1,
  isActive: row.id === activeWorkspaceId,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const latestFailedControlRun = (env: Env, scope: TenantScope) =>
  env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, workflow_intent_id, status, execution_json,
            stage, engine, heartbeat_at, last_event_at, completed_at, failed_at, data_json,
            created_at, updated_at
     FROM control_runs
     WHERE user_id = ? AND workspace_id = ? AND status = 'failed'
       AND NOT EXISTS (
         SELECT 1
         FROM control_runs newer
         WHERE newer.user_id = control_runs.user_id
           AND newer.workspace_id = control_runs.workspace_id
           AND newer.status = 'completed'
           AND (
             newer.updated_at > control_runs.updated_at
             OR (
               newer.updated_at = control_runs.updated_at
               AND newer.created_at > control_runs.created_at
             )
           )
       )
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
  )
    .bind(scope.userId, scope.workspaceId)
    .first<ControlRunRow>();

const latestErrorEvent = (env: Env, scope: TenantScope) =>
  env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, type, summary, target_type, target_id,
            data_json, created_at
     FROM control_plane_events
     WHERE user_id = ?
       AND workspace_id = ?
       AND type NOT LIKE 'chat.%'
       AND (type LIKE '%failed%' OR type LIKE '%error%')
       AND NOT EXISTS (
         SELECT 1
         FROM control_runs newer
         WHERE newer.user_id = control_plane_events.user_id
           AND newer.workspace_id = control_plane_events.workspace_id
           AND newer.status = 'completed'
           AND newer.updated_at > control_plane_events.created_at
       )
     ORDER BY rowid DESC
     LIMIT 1`,
  )
    .bind(scope.userId, scope.workspaceId)
    .first<ControlPlaneEventRow>();

const newestError = (
  candidates: Array<{
    source: "chat" | "execution" | "event";
    message: string;
    status?: string;
    targetId?: string;
    createdAt?: string;
  } | null>,
) => {
  return (
    candidates
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
      .sort((left, right) => {
        const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
        const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
        return rightTime - leftTime;
      })[0] ?? null
  );
};

const emptyCapabilityContext = {
  stage: "observe",
  executionMode: "dry_run",
  surface: "model_exposure",
  platform: "cloudflare-control-plane",
  featureFlags: [],
} as const;

const createDiagnostics = (projection: AdminSummaryProjection): AdminSummaryDiagnostics => ({
  projection,
  totalDurationMs: 0,
  sections: {},
});

const timed = async <T>(
  diagnostics: AdminSummaryDiagnostics,
  label: string,
  load: () => Promise<T>,
  count?: (value: T) => number | undefined,
) => {
  const startedAt = Date.now();
  const value = await load();
  const nextCount = count?.(value);
  diagnostics.sections[label] = {
    durationMs: Date.now() - startedAt,
    ...(typeof nextCount === "number" ? { count: nextCount } : {}),
  };
  return value;
};

const defaultAdminSummaryReaders = {
  selectUser,
  selectWorkspace,
  selectMembership,
  selectAgent,
  selectDefaultAgent,
  selectWorkspaceAgents,
  selectAccountWorkspacesForUser,
  getChatRuntimeSummary,
  readLatestControlRun,
  handleLatestControlPlaneEvents,
  resolveToolSummaries,
  listLatestToolCalls,
  listLatestArtifacts,
  getLatestRuntimeTraceSnapshot,
  listRuntimeTraceSummaries,
  latestFailedControlRun,
  latestErrorEvent,
  getControlRunSnapshot,
};

export type AdminSummaryReaders = typeof defaultAdminSummaryReaders;

export const buildAdminWorkspaceSummary = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
  input?: { readers?: Partial<AdminSummaryReaders> },
) => {
  const startedAt = Date.now();
  const projection = readAdminSummaryProjection(
    new URL(request.url).searchParams.get("projection"),
  );
  const diagnostics = createDiagnostics(projection);
  const readers = { ...defaultAdminSummaryReaders, ...input?.readers };
  const eventLimit = projection === "compact" ? compactEventLimit : drawerEventLimit;

  const [identityRows, chatRuntime, events] = await Promise.all([
    timed(
      diagnostics,
      "identity",
      () =>
        Promise.all([
          readers.selectUser(env, identity.scope.userId),
          readers.selectWorkspace(env, identity.scope.workspaceId),
          readers.selectMembership(env, identity.scope.userId, identity.scope.workspaceId),
          readers.selectAgent(env, identity.agentId, identity.scope.workspaceId),
          readers.selectDefaultAgent(env, identity.scope.workspaceId),
          readers.selectWorkspaceAgents(env, identity.scope.workspaceId),
          identity.accountId
            ? readers.selectAccountWorkspacesForUser(env, {
                userId: identity.scope.userId,
                accountId: identity.accountId,
              })
            : Promise.resolve({ results: [] }),
        ]),
      () => 7,
    ),
    timed(diagnostics, "chatRuntime", () => readers.getChatRuntimeSummary(env, identity)),
    timed(
      diagnostics,
      "events",
      () =>
        readers.handleLatestControlPlaneEvents(
          env,
          identity,
          new URL(`https://internal/events?limit=${eventLimit}`),
        ),
      (value) => value.events?.length,
    ),
  ]);

  const [user, workspace, membership, agent, defaultAgent, agents, accountWorkspaces] =
    identityRows;

  const [failedControlRun, errorEvent] = await timed(
    diagnostics,
    "lastError",
    () =>
      Promise.all([
        readers.latestFailedControlRun(env, identity.scope),
        readers.latestErrorEvent(env, identity.scope),
      ]),
    (value) => value.filter(Boolean).length,
  );

  const drawerReads =
    projection === "drawer"
      ? await Promise.all([
          timed(diagnostics, "demoRun", () => readers.readLatestControlRun(env, identity.scope)),
          timed(
            diagnostics,
            "tools",
            () => readers.resolveToolSummaries(env, identity),
            (value) => value.tools.length,
          ),
          timed(
            diagnostics,
            "toolCalls",
            () => readers.listLatestToolCalls(env, identity.scope),
            (value) => value.length,
          ),
          timed(
            diagnostics,
            "artifacts",
            () => readers.listLatestArtifacts(env, identity.scope),
            (value) => value.length,
          ),
          timed(
            diagnostics,
            "latestTrace",
            () => readers.getLatestRuntimeTraceSnapshot(env, identity.scope),
            (value) => value?.spans.length ?? 0,
          ),
          timed(
            diagnostics,
            "recentTraces",
            () => readers.listRuntimeTraceSummaries(env, identity.scope, 10),
            (value) => value.length,
          ),
        ])
      : null;

  const latestExecutionRun = drawerReads?.[0] ?? null;
  const toolResolution = drawerReads?.[1] ?? {
    context: emptyCapabilityContext,
    decisions: [],
    tools: [],
  };
  const latestToolCalls = drawerReads?.[2] ?? [];
  const latestArtifacts = drawerReads?.[3] ?? [];
  const latestTraceSnapshot = drawerReads?.[4] ?? null;
  const recentTraces = drawerReads?.[5] ?? [];

  const executionSnapshot = latestExecutionRun
    ? await timed(
        diagnostics,
        "executionSnapshot",
        () => readers.getControlRunSnapshot(env, identity.scope, latestExecutionRun.id),
        (value) => (value ? 1 : 0),
      )
    : null;
  const failedControlData = failedControlRun ? parseDataJson(failedControlRun.data_json) : {};
  const lastError = newestError([
    chatRuntime.failure
      ? {
          source: "chat",
          message: chatRuntime.failure.message,
          status: chatRuntime.failure.status,
          targetId: chatRuntime.failure.targetId,
          createdAt: chatRuntime.failure.createdAt,
        }
      : null,
    failedControlRun
      ? {
          source: "execution",
          message:
            typeof failedControlData.error === "string"
              ? failedControlData.error
              : "Workbench execution failed.",
          status: failedControlRun.status,
          targetId: failedControlRun.id,
          createdAt: failedControlRun.updated_at,
        }
      : null,
    errorEvent
      ? {
          source: "event",
          message: errorEvent.summary,
          targetId: errorEvent.target_id ?? errorEvent.id,
          createdAt: errorEvent.created_at,
        }
      : null,
  ]);

  diagnostics.totalDurationMs = Date.now() - startedAt;

  return {
    ok: true,
    summary: {
      generatedAt: new Date().toISOString(),
      diagnostics,
      identity: {
        userId: identity.scope.userId,
        workspaceId: identity.scope.workspaceId,
        agentId: identity.agentId,
        authMode: readOptionalHeader(request, authModeHeader) ?? "unknown",
        workspaceSource: readOptionalHeader(request, workspaceSourceHeader) ?? "unknown",
      },
      account: workspace
        ? {
            id: workspace.account_id,
            source: workspace.account_source,
          }
        : null,
      user: user
        ? {
            id: user.id,
            email: user.email,
            displayName: user.display_name,
            status: user.status,
          }
        : null,
      workspace: workspace
        ? {
            id: workspace.id,
            name: workspace.name,
            status: workspace.status,
            isDefault: workspace.is_default === 1,
            isActive: true,
          }
        : null,
      workspaces: accountWorkspaces.results.map((accountWorkspace) =>
        toWorkspaceSummary(accountWorkspace, identity.scope.workspaceId),
      ),
      membership: membership
        ? {
            source: "cloudflare-d1",
            role: membership.role,
            status: membership.status,
            roles: parseStringArray(membership.roles_json),
            permissions: parseStringArray(membership.permissions_json),
          }
        : null,
      externalMembership: externalMembershipSummary(request),
      activeAgent: agent ? toAgentSummary(env, agent, identity.agentId) : null,
      defaultAgent: defaultAgent ? toAgentSummary(env, defaultAgent, identity.agentId) : null,
      agents: agents.results.map((workspaceAgent) =>
        toAgentSummary(env, workspaceAgent, identity.agentId),
      ),
      chat: {
        latestSession: chatRuntime.latestSession,
        latestThread: chatRuntime.latestThread,
        latestRun: chatRuntime.latestRun,
        latestIntent: chatRuntime.latestIntent,
        latestPolicyDecision: chatRuntime.latestPolicyDecision,
      },
      chatRuntime,
      execution: {
        latestRun: executionSnapshot,
      },
      capabilityContext: toolResolution.context,
      capabilityDecisions: toolResolution.decisions,
      tools: toolResolution.tools,
      latestToolCalls,
      latestArtifacts,
      latestTrace: latestTraceSnapshot?.trace ?? null,
      recentTraces,
      traceWaterfall: latestTraceSnapshot?.spans ?? [],
      events: events.events ?? [],
      lastError,
    },
  };
};

export const handleAdminWorkspaceSummary = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
) => json(await buildAdminWorkspaceSummary(request, env, identity));
