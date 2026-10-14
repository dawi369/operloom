import {
  assertSchemaValue,
  type RuntimeDelegationTask,
  type RuntimeRecord,
  type RuntimeTaskPort,
  type RuntimeWorkflowBinding,
} from "@operloom/agent-sdk/control-plane";
import type { AgentPackResourceLimits, AgentPackWorkflow } from "@operloom/agent-sdk/manifest";
import {
  buildPackWorkflowRequest,
  packWorkflowBindings,
  resolvePackRuntime,
  type PackWorkflowType,
} from "../../../lib/agent-runtime/registry";
import { agentManifestRegistry } from "../../../generated/agent-runtime/manifests";
import { resolveAgentBehaviorConfig } from "./agent-records";
import { selectAgent } from "./authz-store";
import { sha256Hex } from "./connection-broker-shared";
import { isRecord, parseDataJson } from "./http";
import { executeRuntimeWorkflow } from "./pack-workflow-runtime";
import { runtimeStateCanonicalJson } from "./runtime-state";
import { createId, toJson, type AgentIdentity, type Env } from "./types";

export const defaultDelegationDepth = 2;
export const defaultDelegationFanOut = 4;
const leaseDurationMs = 2 * 60 * 1000;
const maxDeadlineMs = 24 * 60 * 60 * 1000;

export type DelegationTaskRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  parent_run_id: string;
  root_run_id: string;
  requester_agent_id: string;
  target_agent_id: string;
  workflow_type: string;
  idempotency_key: string;
  input_json: string;
  input_sha256: string;
  status: RuntimeDelegationTask["status"];
  depth: number;
  run_id: string | null;
  result_json: string;
  error_json: string;
  deadline_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

const taskColumns = `id, user_id, workspace_id, parent_run_id, root_run_id, requester_agent_id, target_agent_id,
  workflow_type, idempotency_key, input_json, input_sha256, status, depth, run_id, result_json, error_json,
  deadline_at, lease_owner, lease_expires_at, created_at, updated_at`;

const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

const toTask = (row: DelegationTaskRow): RuntimeDelegationTask => {
  const error = parseDataJson(row.error_json);
  return {
    taskId: row.id,
    status: row.status,
    targetAgentId: row.target_agent_id,
    workflowType: row.workflow_type,
    runId: row.run_id,
    result: row.status === "succeeded" ? (parseDataJson(row.result_json) as RuntimeRecord) : null,
    error:
      typeof error.code === "string"
        ? { code: error.code, message: typeof error.message === "string" ? error.message : "" }
        : null,
    deadlineAt: row.deadline_at,
  };
};

const manifestFor = (packId: string) =>
  agentManifestRegistry[packId as keyof typeof agentManifestRegistry]?.module as
    | { workflows: readonly AgentPackWorkflow[]; resourceLimits: AgentPackResourceLimits }
    | undefined;
const manifestLimits = (packId: string) => manifestFor(packId)?.resourceLimits;

/** Where the requesting run sits in a delegation chain; a root run is depth 0. */
export const runDelegationDepth = (runData: Record<string, unknown>) => {
  const delegation = isRecord(runData.delegation) ? runData.delegation : null;
  return typeof delegation?.depth === "number" && Number.isFinite(delegation.depth)
    ? Math.trunc(delegation.depth)
    : 0;
};

export const createTaskPort = (
  env: Env,
  identity: AgentIdentity,
  input: { packId: string; runId: string; runData: Record<string, unknown> },
): RuntimeTaskPort => ({
  async delegate(request) {
    if (
      !request ||
      typeof request.agentId !== "string" ||
      !request.agentId ||
      typeof request.workflowType !== "string" ||
      !isRecord(request.input) ||
      typeof request.idempotencyKey !== "string" ||
      request.idempotencyKey.length < 1 ||
      request.idempotencyKey.length > 200 ||
      !Number.isSafeInteger(request.deadlineMs) ||
      request.deadlineMs < 60_000 ||
      request.deadlineMs > maxDeadlineMs
    )
      throw fail("delegation_invalid", "Delegation request is invalid.");
    const target = await selectAgent(env, request.agentId, identity.scope.workspaceId);
    if (!target || target.status !== "active")
      throw fail(
        "delegation_target_unavailable",
        "The target agent is not active in this workspace.",
      );
    const targetPack = resolveAgentBehaviorConfig(target).pack;
    const binding = packWorkflowBindings[request.workflowType as PackWorkflowType];
    if (!targetPack || !binding || binding.requiredPackId !== targetPack.id)
      throw fail("delegation_workflow_unavailable", "The target agent does not run that workflow.");
    const targetManifest = manifestFor(targetPack.id);
    const declared = targetManifest?.workflows.find((item) => item.type === request.workflowType);
    if (!declared || (!declared.userInvocable && !declared.delegable))
      throw fail("delegation_workflow_not_delegable", "The workflow is not delegable.");
    const runtime = resolvePackRuntime(targetPack.id, targetPack.version);
    if (!runtime.runnable)
      throw fail("delegation_runtime_incompatible", "The target agent's runtime cannot run.");
    const workflow = runtime.controlPlane.workflows.find(
      (item) => item.type === request.workflowType,
    ) as RuntimeWorkflowBinding | undefined;
    if (!workflow)
      throw fail("delegation_workflow_unavailable", "The workflow binding is unavailable.");
    const normalized = workflow.normalizeInput
      ? workflow.normalizeInput(request.input)
      : request.input;
    assertSchemaValue(workflow.inputSchema, normalized, `${request.workflowType} input`);
    const depth = runDelegationDepth(input.runData) + 1;
    const maxDepth = targetManifest?.resourceLimits.maxDelegationDepth ?? defaultDelegationDepth;
    if (depth > maxDepth)
      throw fail("delegation_depth_exceeded", `Delegation depth ${depth} exceeds ${maxDepth}.`);
    const inputSha256 = await sha256Hex(
      runtimeStateCanonicalJson({ ...request, input: normalized }),
    );
    const existing = await env.DB.prepare(
      `SELECT ${taskColumns} FROM control_delegation_tasks WHERE parent_run_id = ? AND idempotency_key = ?`,
    )
      .bind(input.runId, request.idempotencyKey)
      .first<DelegationTaskRow>();
    if (existing) {
      if (existing.input_sha256 !== inputSha256)
        throw fail("idempotency_conflict", "The task key already identifies different content.");
      return { taskId: existing.id, status: existing.status, created: false };
    }
    const fanOut = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM control_delegation_tasks WHERE parent_run_id = ?`,
    )
      .bind(input.runId)
      .first<{ n: number }>();
    const maxFanOut = manifestLimits(input.packId)?.maxDelegationFanOut ?? defaultDelegationFanOut;
    if (Number(fanOut?.n ?? 0) >= maxFanOut)
      throw fail(
        "delegation_fan_out_exceeded",
        `This run may delegate at most ${maxFanOut} tasks.`,
      );
    const rootRunId =
      isRecord(input.runData.delegation) && typeof input.runData.delegation.rootRunId === "string"
        ? input.runData.delegation.rootRunId
        : input.runId;
    const id = createId("cf-task");
    const now = new Date();
    const timestamp = now.toISOString();
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO control_delegation_tasks (
         id, user_id, workspace_id, parent_run_id, root_run_id, requester_agent_id, target_agent_id,
         workflow_type, idempotency_key, input_json, input_sha256, status, depth, deadline_at,
         created_at, updated_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM control_runs WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?
             AND status IN ('queued', 'running', 'waiting', 'interrupted')
         )`,
    )
      .bind(
        id,
        identity.scope.userId,
        identity.scope.workspaceId,
        input.runId,
        rootRunId,
        identity.agentId,
        target.id,
        request.workflowType,
        request.idempotencyKey,
        toJson(normalized),
        inputSha256,
        depth,
        new Date(now.getTime() + request.deadlineMs).toISOString(),
        timestamp,
        timestamp,
        input.runId,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
      )
      .run();
    if (((inserted as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) {
      const raced = await env.DB.prepare(
        `SELECT ${taskColumns} FROM control_delegation_tasks WHERE parent_run_id = ? AND idempotency_key = ?`,
      )
        .bind(input.runId, request.idempotencyKey)
        .first<DelegationTaskRow>();
      if (raced) return { taskId: raced.id, status: raced.status, created: false };
      throw fail("delegation_run_inactive", "Only a live run may delegate.");
    }
    return { taskId: id, status: "queued", created: true };
  },
  async result(taskId) {
    const row = await env.DB.prepare(
      `SELECT ${taskColumns} FROM control_delegation_tasks
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND requester_agent_id = ?`,
    )
      .bind(taskId, identity.scope.userId, identity.scope.workspaceId, identity.agentId)
      .first<DelegationTaskRow>();
    if (!row) throw fail("delegation_task_not_found", "The task is not visible to this agent.");
    return toTask(row);
  },
});

/** Tasks a run delegated, for its history snapshot. */
export const listDelegationTasksForRun = async (
  env: Env,
  scope: { userId: string; workspaceId: string },
  parentRunId: string,
) =>
  (
    await env.DB.prepare(
      `SELECT ${taskColumns} FROM control_delegation_tasks
       WHERE user_id = ? AND workspace_id = ? AND parent_run_id = ? ORDER BY created_at`,
    )
      .bind(scope.userId, scope.workspaceId, parentRunId)
      .all<DelegationTaskRow>()
  ).results.map(toTask);

/** Queued children die with the parent; only once the parent's cancellation has landed. */
export const cancelDelegationTasksForRun = (
  env: Env,
  scope: { userId: string; workspaceId: string },
  runId: string,
  timestamp: string,
) =>
  env.DB.prepare(
    `UPDATE control_delegation_tasks SET status = 'cancelled', error_json = ?, updated_at = ?
     WHERE user_id = ? AND workspace_id = ? AND status = 'queued' AND parent_run_id = ?
       AND EXISTS (
         SELECT 1 FROM control_runs WHERE user_id = ? AND workspace_id = ? AND id = ? AND status = 'cancelled'
       )`,
  ).bind(
    toJson({ code: "parent_cancelled", message: "The requesting run was cancelled." }),
    timestamp,
    scope.userId,
    scope.workspaceId,
    runId,
    scope.userId,
    scope.workspaceId,
    runId,
  );

/** Marks the task whose child run reached a terminal state. */
export const completeDelegationTaskStatement = (
  env: Env,
  identity: AgentIdentity,
  input: {
    runId: string;
    ok: boolean;
    output?: RuntimeRecord;
    error?: { code: string; message: string };
    timestamp: string;
  },
) =>
  env.DB.prepare(
    `UPDATE control_delegation_tasks SET status = ?, result_json = ?, error_json = ?, lease_owner = NULL,
       lease_expires_at = NULL, updated_at = ?
     WHERE user_id = ? AND workspace_id = ? AND target_agent_id = ? AND run_id = ? AND status = 'running'`,
  ).bind(
    input.ok ? "succeeded" : "failed",
    toJson(input.ok ? (input.output ?? {}) : {}),
    toJson(
      input.ok
        ? {}
        : (input.error ?? { code: "workflow_failed", message: "The delegated run failed." }),
    ),
    input.timestamp,
    identity.scope.userId,
    identity.scope.workspaceId,
    identity.agentId,
    input.runId,
  );

/** Scheduler step: lease queued tasks and run them as the target agent. */
export const dispatchDelegationTasks = async (
  env: Env,
  input: { now?: Date; leaseOwner: string; limit?: number },
) => {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 10), 1), 25);
  const expired = await env.DB.prepare(
    `UPDATE control_delegation_tasks SET status = 'expired', error_json = ?, updated_at = ?
     WHERE status = 'queued' AND deadline_at <= ?`,
  )
    .bind(
      toJson({ code: "deadline_passed", message: "The task was not started before its deadline." }),
      timestamp,
      timestamp,
    )
    .run();
  const abandoned = await env.DB.prepare(
    `UPDATE control_delegation_tasks SET status = 'failed', error_json = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE status = 'running' AND run_id IS NULL AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
  )
    .bind(
      toJson({
        code: "dispatch_lost",
        message: "The dispatch lease expired before a run started.",
      }),
      timestamp,
      timestamp,
    )
    .run();
  const candidates = await env.DB.prepare(
    `SELECT id FROM control_delegation_tasks WHERE status = 'queued' AND deadline_at > ?
     ORDER BY created_at ASC LIMIT ?`,
  )
    .bind(timestamp, limit)
    .all<{ id: string }>();
  const results: { taskId: string; ok: boolean; code?: string }[] = [];
  for (const candidate of candidates.results) {
    const leased = await env.DB.prepare(
      `UPDATE control_delegation_tasks SET status = 'running', lease_owner = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'queued'`,
    )
      .bind(
        input.leaseOwner,
        new Date(now.getTime() + leaseDurationMs).toISOString(),
        timestamp,
        candidate.id,
      )
      .run();
    if (((leased as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) continue;
    const task = await env.DB.prepare(
      `SELECT ${taskColumns} FROM control_delegation_tasks WHERE id = ?`,
    )
      .bind(candidate.id)
      .first<DelegationTaskRow>();
    if (!task) continue;
    const outcome = await executeLeasedDelegationTask(env, task);
    results.push({ taskId: task.id, ...outcome });
  }
  return {
    expired: (expired as { meta?: { changes?: number } }).meta?.changes ?? 0,
    abandoned: (abandoned as { meta?: { changes?: number } }).meta?.changes ?? 0,
    dispatched: results.length,
    results,
  };
};

const failTask = (env: Env, task: DelegationTaskRow, error: { code: string; message: string }) =>
  env.DB.prepare(
    `UPDATE control_delegation_tasks SET status = 'failed', error_json = ?, lease_owner = NULL,
       lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND run_id IS NULL`,
  )
    .bind(toJson(error), new Date().toISOString(), task.id)
    .run();

const executeLeasedDelegationTask = async (env: Env, task: DelegationTaskRow) => {
  const binding = packWorkflowBindings[task.workflow_type as PackWorkflowType];
  if (!binding) {
    await failTask(env, task, {
      code: "delegation_workflow_unavailable",
      message: "The workflow is unavailable.",
    });
    return { ok: false as const, code: "delegation_workflow_unavailable" };
  }
  const request = buildPackWorkflowRequest(
    task.workflow_type,
    parseDataJson(task.input_json) as RuntimeRecord,
  );
  if (!request) {
    await failTask(env, task, {
      code: "delegation_input_invalid",
      message: "The task input is invalid.",
    });
    return { ok: false as const, code: "delegation_input_invalid" };
  }
  const identity: AgentIdentity = {
    scope: { userId: task.user_id, workspaceId: task.workspace_id },
    agentId: task.target_agent_id,
  };
  try {
    const response = await executeRuntimeWorkflow(
      task.workflow_type,
      new Request(
        new URL(
          binding.workerRoute,
          env.OPERLOOM_CALLBACK_URL?.trim() || "https://operloom.internal",
        ),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        },
      ),
      env,
      identity,
      {
        source: "delegation",
        taskId: task.id,
        parentRunId: task.parent_run_id,
        rootRunId: task.root_run_id,
        requesterAgentId: task.requester_agent_id,
        deadlineAt: task.deadline_at,
        depth: task.depth,
        leaseOwner: task.lease_owner ?? "",
      },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { code?: string; error?: string };
      await failTask(env, task, {
        code: typeof body.code === "string" ? body.code : "delegation_rejected",
        message:
          typeof body.error === "string" ? body.error : "The target agent rejected the task.",
      });
      return {
        ok: false as const,
        code: typeof body.code === "string" ? body.code : "delegation_rejected",
      };
    }
    return { ok: true as const };
  } catch {
    await failTask(env, task, {
      code: "delegation_execution_failed",
      message: "The task could not be executed.",
    });
    return { ok: false as const, code: "delegation_execution_failed" };
  }
};
