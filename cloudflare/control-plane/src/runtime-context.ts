import { durableAttemptGuard, type DurableAttemptAuthority } from "./durable-attempt-authority";
import {
  collectRuntimeContext,
  assertRuntimeContextReady,
  type RuntimeContextSnapshot,
  type RuntimeContextPort,
  type RuntimeRecord,
  type AgentExecutionContext,
  type ControlPlaneRuntimeModule,
} from "@operloom/agent-sdk";
import { agentControlPlaneRegistry } from "../../../generated/agent-runtime/control-plane";
import { resolvePackRuntime } from "../../../lib/agent-runtime/registry";
import { sha256Hex } from "../../../lib/workbench/control-plane-signing";
import { resolveAgentBehaviorConfig, resolveAgentRuntimeConfig } from "./agent-records";
import { createRuntimeStatePort, runtimeStateCanonicalJson } from "./runtime-state";
import type { AgentIdentity, AgentRow, Env } from "./types";
import { json } from "./http";
import { publicContextContracts } from "../../../packages/workbench-client/src/public-context-contracts";

const authority = `SELECT a.* FROM agents a JOIN workspaces w ON w.id = a.workspace_id AND w.status = 'active'
  JOIN memberships m ON m.workspace_id = w.id AND m.user_id = ? AND m.status = 'active'
  JOIN users u ON u.id = m.user_id AND u.status = 'active'
  WHERE a.workspace_id = ? AND a.id = ? AND a.status = 'active'`;
const actor = (identity: AgentIdentity) => [
  identity.scope.userId,
  identity.scope.workspaceId,
  identity.agentId,
];
const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};
const frozen = <T>(value: T): T => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
};
export const contextIsRequired = (runtime: ReturnType<typeof resolvePackRuntime>) =>
  runtime.runnable && runtime.controlPlane.requirements.capabilities.includes("context.snapshots");

/** One capture per logical step (or legacy run). Retries retain evidence; later steps recapture it. */
export const captureRuntimeContext = async (
  env: Env,
  identity: AgentIdentity,
  input: {
    runId: string;
    runKind: "workflow" | "chat";
    input: RuntimeRecord;
    target: "simulation" | "external";
    signal: AbortSignal;
    durableAttempt?: DurableAttemptAuthority;
  },
): Promise<RuntimeContextPort | undefined> => {
  input = { ...input, durableAttempt: input.durableAttempt && { ...input.durableAttempt } };
  if (input.durableAttempt && input.runKind !== "workflow")
    return fail("context_capture_invalid", "Durable evidence must belong to a workflow step");
  const attemptGuard = durableAttemptGuard(identity, input.runId, input.durableAttempt);
  input.signal.throwIfAborted();
  const agent = await env.DB.prepare(`${authority} AND ${attemptGuard.sql}`)
    .bind(...actor(identity), ...attemptGuard.values)
    .first<AgentRow>();
  if (!agent || (agent.runtime_revision ?? 0) !== (identity.agentRevision ?? 0))
    return fail("context_authority_revoked", "Context authority or agent revision changed");
  const pack = resolveAgentBehaviorConfig(agent).pack;
  if (!pack) return undefined;
  const runtime = resolvePackRuntime(pack.id, pack.version);
  if (!runtime.runnable) {
    // Unrunnable runtimes may still chat unless they require context.
    const saved = JSON.parse(agent.data_json).runtimeModuleSnapshot;
    const installed = agentControlPlaneRegistry[pack.id as keyof typeof agentControlPlaneRegistry]
      ?.module as ControlPlaneRuntimeModule | undefined;
    if (
      saved?.requirements?.capabilities?.includes("context.snapshots") ||
      installed?.requirements.capabilities.includes("context.snapshots")
    )
      return fail(
        "context_runtime_unavailable",
        "This agent's required context runtime is unavailable",
      );
    return undefined;
  }
  if (!contextIsRequired(runtime)) return undefined;
  if (env.WORKBENCH_CONTEXT_ENABLED !== "true")
    return fail("runtime_capability_disabled", "Scoped context is disabled");
  const configurationHash = await sha256Hex(
    runtimeStateCanonicalJson([
      JSON.parse(agent.data_json),
      JSON.parse(JSON.stringify(resolveAgentRuntimeConfig(env, agent))),
    ]),
  );
  const inputHash = await sha256Hex(runtimeStateCanonicalJson(input.input));
  const contractHash = await sha256Hex(
    runtimeStateCanonicalJson({
      descriptors: pack.context,
      bindings: (runtime.controlPlane.context ?? []).map(
        ({ resolve: _resolve, ...metadata }) => metadata,
      ),
    }),
  );
  const requestHash = await sha256Hex(
    runtimeStateCanonicalJson([
      configurationHash,
      inputHash,
      contractHash,
      input.target,
      pack.version,
      runtime.runtimeVersion,
      identity.agentRevision ?? 0,
    ]),
  );
  const captureKey = input.durableAttempt ? `step:${input.durableAttempt.stepId}` : "run";
  const identityParts = [...actor(identity), input.runKind, input.runId];
  // Preserve the exact historical ID for request-mode captures.
  const id = `context-${await sha256Hex(runtimeStateCanonicalJson(input.durableAttempt ? [...identityParts, captureKey] : identityParts))}`;
  const table = input.runKind === "workflow" ? "control_runs" : "chat_runs";
  const metadata = input.runKind === "workflow" ? "data_json" : "metadata_json";
  const liveRun = `SELECT 1 FROM ${table} WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ? AND status = 'running'
    AND COALESCE(json_extract(${metadata}, '$.agentRevision'), 0) = ?`;
  const runValues = [input.runId, ...actor(identity), identity.agentRevision ?? 0];
  const read = () =>
    env.DB.prepare(`SELECT request_hash, snapshot_json FROM control_context_snapshots WHERE id = ?
    AND user_id = ? AND workspace_id = ? AND agent_id = ? AND EXISTS (${authority} AND a.runtime_revision = ? AND a.data_json = ?) AND ${attemptGuard.sql}`)
      .bind(
        id,
        ...actor(identity),
        ...actor(identity),
        identity.agentRevision ?? 0,
        agent.data_json,
        ...attemptGuard.values,
      )
      .first<{ request_hash: string; snapshot_json: string }>();
  const port = (snapshot: RuntimeContextSnapshot): RuntimeContextPort => ({
    snapshot: frozen(snapshot),
    assertReady() {
      input.signal.throwIfAborted();
      assertRuntimeContextReady(snapshot);
    },
  });
  const replay = (row: { request_hash: string; snapshot_json: string }) => {
    if (row.request_hash !== requestHash)
      return fail(
        "context_snapshot_conflict",
        "This logical capture already used different context inputs",
      );
    return port(JSON.parse(row.snapshot_json));
  };
  const previous = await read();
  if (previous) return replay(previous);
  if (
    !(await env.DB.prepare(liveRun)
      .bind(...runValues)
      .first())
  )
    return fail("context_run_inactive", "Context capture requires an active canonical run");
  if ((runtime.controlPlane.state?.length ?? 0) > 0 && env.WORKBENCH_TYPED_STATE_ENABLED !== "true")
    return fail("runtime_capability_disabled", "Context requires enabled typed state");
  const state =
    env.WORKBENCH_TYPED_STATE_ENABLED === "true"
      ? await createRuntimeStatePort(env, identity, {
          packId: pack.id,
          target: input.target,
          definitions: runtime.controlPlane.state ?? [],
          signal: input.signal,
          runId: input.runKind === "workflow" ? input.runId : undefined,
          durableAttempt: input.durableAttempt,
        })
      : undefined;
  const evidence = await collectRuntimeContext({
    descriptors: pack.context,
    bindings: runtime.controlPlane.context ?? [],
    scope: { ...identity.scope, agentId: identity.agentId },
    input: input.input,
    signal: input.signal,
    state: state
      ? Object.freeze({ get: state.get.bind(state), list: state.list.bind(state) })
      : undefined,
  });
  const contentHash = await sha256Hex(
    runtimeStateCanonicalJson(
      evidence.sources.map((source) => ({
        id: source.id,
        version: source.version,
        status: source.status,
        trust: source.trust,
        data: source.data ?? null,
        provenance: source.provenance ?? [],
      })),
    ),
  );
  const snapshot: RuntimeContextSnapshot = {
    ...evidence,
    id,
    runId: input.runId,
    runKind: input.runKind,
    target: input.target,
    agentRevision: identity.agentRevision ?? 0,
    packId: pack.id,
    packVersion: pack.version,
    runtimeVersion: runtime.runtimeVersion,
    configurationHash,
    inputHash,
    contentHash,
    captureKey,
    ...(input.durableAttempt ? { stepId: input.durableAttempt.stepId } : {}),
  };
  const serialized = JSON.stringify(snapshot);
  if (new TextEncoder().encode(serialized).length > 131072)
    return fail("context_snapshot_limit", "Context snapshot exceeds 128 KiB");
  input.signal.throwIfAborted();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO control_context_snapshots
        (id,user_id,workspace_id,agent_id,run_id,run_kind,agent_revision,pack_id,request_hash,snapshot_json,status,created_at,preconditions_met,capture_key,step_id,revision)
        SELECT ?,?,?,?,?,?,?,?,?,json_set(?, '$.revision', next.revision),?,?, CASE WHEN next.revision<=128 AND ${attemptGuard.sql} AND EXISTS (${authority} AND a.runtime_revision = ? AND a.data_json = ?)
          AND EXISTS (${liveRun}) AND NOT EXISTS (SELECT 1 FROM control_kill_switches WHERE user_id = ? AND workspace_id = ? AND enabled = 1
            AND ((scope_kind = 'workspace' AND scope_id = ?) OR (scope_kind = 'pack' AND scope_id = ?))) THEN 1 ELSE 0 END,?,?,next.revision
        FROM (SELECT COALESCE(MAX(revision),-1)+1 revision FROM control_context_snapshots
          WHERE user_id=? AND workspace_id=? AND agent_id=? AND run_kind=? AND run_id=?) next`).bind(
        id,
        ...actor(identity),
        input.runId,
        input.runKind,
        identity.agentRevision ?? 0,
        pack.id,
        requestHash,
        serialized,
        snapshot.status,
        snapshot.capturedAt,
        ...attemptGuard.values,
        ...actor(identity),
        identity.agentRevision ?? 0,
        agent.data_json,
        ...runValues,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.scope.workspaceId,
        pack.id,
        captureKey,
        input.durableAttempt?.stepId ?? null,
        ...actor(identity),
        input.runKind,
        input.runId,
      ),
      env.DB.prepare(
        `UPDATE ${table} SET ${metadata} = json_set(${metadata}, '$.contextSnapshotId', ?, '$.contextStatus', ?) WHERE id = ?`,
      ).bind(id, snapshot.status, input.runId),
      env.DB.prepare(`INSERT INTO control_plane_events (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
        VALUES (?,?,?,?,'context.captured','Scoped context evidence captured.','run',?,
          json_set(?, '$.revision', (SELECT revision FROM control_context_snapshots WHERE id=?)),?)`).bind(
        id,
        ...actor(identity),
        input.runId,
        JSON.stringify({
          snapshotId: id,
          status: snapshot.status,
          captureKey,
          stepId: input.durableAttempt?.stepId,
        }),
        id,
        snapshot.capturedAt,
      ),
    ]);
  } catch (error) {
    const concurrent = await read();
    if (concurrent) return replay(concurrent);
    if (String(error).includes("context_snapshot_precondition"))
      return fail("context_authority_revoked", "Context publication authority changed");
    return fail(
      String(error).includes("workspace_export_in_progress")
        ? "workspace_export_in_progress"
        : "context_persist_failed",
      "Context evidence could not be committed; no partial snapshot was accepted.",
    );
  }
  const committed = await read();
  if (!committed)
    return fail("context_authority_revoked", "Context authority changed after publication");
  return replay(committed);
};

export const handleGetContextSnapshot = async (env: Env, identity: AgentIdentity, id: string) => {
  const row = await env.DB.prepare(`SELECT snapshot_json FROM control_context_snapshots WHERE id = ?
    AND user_id = ? AND workspace_id = ? AND agent_id = ? AND EXISTS (${authority})`)
    .bind(id, ...actor(identity), ...actor(identity))
    .first<{ snapshot_json: string }>();
  return row
    ? json({ ok: true, snapshot: JSON.parse(row.snapshot_json) })
    : json(
        { ok: false, code: "context_snapshot_not_found", error: "Context snapshot not found" },
        { status: 404 },
      );
};

export const handleListContextSnapshots = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
) => {
  const parsed = publicContextContracts["GET /workbench/context-snapshots"].query.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success)
    return json(
      {
        ok: false,
        code: "invalid_context_query",
        error: "Provide a run identity, kind and bounded revision cursor.",
      },
      { status: 400 },
    );
  const { runId, runKind, afterRevision, limit } = parsed.data;
  const rows =
    await env.DB.prepare(`SELECT id,capture_key captureKey,revision,step_id stepId,status,created_at capturedAt
    FROM control_context_snapshots WHERE user_id=? AND workspace_id=? AND agent_id=? AND run_kind=? AND run_id=?
    AND revision>? AND EXISTS (${authority}) ORDER BY revision LIMIT ?`)
      .bind(...actor(identity), runKind, runId, afterRevision ?? -1, ...actor(identity), limit + 1)
      .all<{
        id: string;
        captureKey: string;
        revision: number;
        stepId: string | null;
        status: "ready" | "blocked";
        capturedAt: string;
      }>();
  const snapshots = rows.results.slice(0, limit);
  return json({
    ok: true,
    snapshots,
    ...(rows.results.length > limit ? { nextAfterRevision: snapshots.at(-1)!.revision } : {}),
  });
};

/** All runtime-provided mutation/tool ports check required freshness before starting work. */
export const bindRuntimeContext = (
  context: AgentExecutionContext,
  evidence: RuntimeContextPort,
) => {
  context.context = evidence;
  const actions = context.actions,
    tools = context.tools,
    managed = context.managedState;
  context.actions = {
    ...(actions.simulate
      ? {
          async simulate(input: import("@operloom/agent-sdk").RuntimeSimulationCommit) {
            evidence.assertReady();
            return actions.simulate!(input);
          },
        }
      : {}),
    async propose(input) {
      evidence.assertReady();
      return actions.propose(input);
    },
    async execute(id) {
      evidence.assertReady();
      return actions.execute(id);
    },
    ...(actions.reconcile
      ? {
          async reconcile(id: string) {
            evidence.assertReady();
            return actions.reconcile!(id);
          },
        }
      : {}),
  };
  context.tools = {
    async invoke(id, input) {
      evidence.assertReady();
      return tools.invoke(id, input);
    },
  };
  context.managedState = {
    async upsert(input) {
      evidence.assertReady();
      return managed.upsert(input);
    },
  };
};

export const agentRequiresRuntimeContext = (agent: AgentRow) => {
  const pack = resolveAgentBehaviorConfig(agent).pack;
  return Boolean(
    pack &&
    (contextIsRequired(resolvePackRuntime(pack.id, pack.version)) ||
      JSON.parse(agent.data_json).runtimeModuleSnapshot?.requirements?.capabilities?.includes(
        "context.snapshots",
      )),
  );
};
