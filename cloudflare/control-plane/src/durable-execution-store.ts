import {
  assertSchemaDefinition,
  assertSchemaValue,
  type JsonSchema,
  type RuntimeRecord,
} from "@operloom/agent-sdk";
import { durableExecutionLiveSql as live } from "./durable-attempt-authority";
import { sha256Hex } from "../../../lib/workbench/control-plane-signing";
import { resolveAgentBehaviorConfig, resolveAgentRuntimeConfig } from "./agent-records";
import { runtimeStateCanonicalJson } from "./runtime-state";
import { buildControlRunRelation } from "./run-relations";
import { createId, type AgentIdentity, type AgentRow, type Env } from "./types";
import {
  durableTriggerLinkStatement,
  type DurableTriggerInvocation,
} from "./durable-trigger-links";

// Internal persistence kernel. No public capability is enabled until the engine adapter is accepted.
export type DurableExecution = {
  run_id: string;
  workflow_intent_id: string;
  instance_id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  agent_revision: number;
  pack_id: string;
  pack_version: string;
  runtime_version: string;
  workflow_type: string;
  workflow_version: string;
  definition_hash: string;
  agent_data_json: string;
  configuration_hash: string;
  request_hash: string;
  input_json: string;
  max_steps: number;
  deadline: string;
  status: "pending" | "started" | "closed";
};
export type DurableStep = {
  id: string;
  run_id: string;
  step_key: string;
  step_version: string;
  request_hash: string;
  output_schema_json: string;
  replay_safe: number;
  max_attempts: number;
  timeout_ms: number;
  attempt_count: number;
  active_attempt_id: string;
  expires_at: string;
  status: "running" | "completed" | "failed" | "outcome_unknown";
  output_json: string | null;
  outcome_hash: string | null;
  error_code: string | null;
};
export type DurableStepOutcome =
  | { status: "completed"; output: RuntimeRecord }
  | { status: "failed" | "outcome_unknown"; errorCode: string };
const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};
const scope = (identity: AgentIdentity) => [
  identity.scope.userId,
  identity.scope.workspaceId,
  identity.agentId,
];
const hash = (value: unknown) => sha256Hex(runtimeStateCanonicalJson(value));
const key = (value: string) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
const boundedJson = (value: unknown, bytes: number) => {
  const json = runtimeStateCanonicalJson(value);
  if (new TextEncoder().encode(json).length > bytes)
    fail("durable_payload_limit", "Durable payload exceeds its declared storage bound");
  return json;
};
const configurationHash = (env: Env, agent: AgentRow) =>
  hash([
    JSON.parse(agent.data_json),
    JSON.parse(JSON.stringify(resolveAgentRuntimeConfig(env, agent))),
  ]);
const actorAuthority = `SELECT a.* FROM agents a
 JOIN workspaces w ON w.id=a.workspace_id AND w.status='active'
 JOIN memberships m ON m.workspace_id=w.id AND m.user_id=? AND m.status='active'
 JOIN users u ON u.id=m.user_id AND u.status='active'
 WHERE a.workspace_id=? AND a.id=? AND a.status='active' AND a.runtime_revision=?`;

const readExecution = (env: Env, identity: AgentIdentity, runId: string) =>
  env.DB.prepare(
    "SELECT * FROM control_durable_executions WHERE run_id=? AND user_id=? AND workspace_id=? AND agent_id=?",
  )
    .bind(runId, ...scope(identity))
    .first<DurableExecution>();
const readSubmission = (env: Env, identity: AgentIdentity, submissionKey: string) =>
  env.DB.prepare(
    "SELECT * FROM control_durable_executions WHERE user_id=? AND workspace_id=? AND agent_id=? AND submission_key=?",
  )
    .bind(...scope(identity), submissionKey)
    .first<DurableExecution>();
const readStep = (env: Env, identity: AgentIdentity, runId: string, stepId: string) =>
  env.DB.prepare(
    `SELECT s.*,a.output_json,a.outcome_hash,a.error_code FROM control_durable_steps s
   JOIN control_durable_step_attempts a ON a.id=s.active_attempt_id AND a.step_id=s.id AND a.run_id=s.run_id
     AND a.user_id=s.user_id AND a.workspace_id=s.workspace_id AND a.agent_id=s.agent_id
   WHERE s.id=? AND s.run_id=? AND s.user_id=? AND s.workspace_id=? AND s.agent_id=?`,
  )
    .bind(stepId, runId, ...scope(identity))
    .first<DurableStep>();

export const requireDurableExecutionAuthority = async (
  env: Env,
  identity: AgentIdentity,
  runId: string,
  pins?: { definitionHash: string; workflowVersion: string; runtimeVersion: string },
) => {
  const [execution, agent] = await Promise.all([
    readExecution(env, identity, runId),
    env.DB.prepare(actorAuthority)
      .bind(...scope(identity), identity.agentRevision ?? 0)
      .first<AgentRow>(),
  ]);
  if (!execution || !agent || execution.agent_revision !== (identity.agentRevision ?? 0))
    return fail(
      "durable_authority_revoked",
      "Durable execution is unavailable in the current scope",
    );
  if (
    execution.agent_data_json !== agent.data_json ||
    execution.configuration_hash !== (await configurationHash(env, agent))
  )
    return fail(
      "durable_configuration_changed",
      "The pinned execution configuration is unavailable",
    );
  if (
    pins &&
    (pins.definitionHash !== execution.definition_hash ||
      pins.workflowVersion !== execution.workflow_version ||
      pins.runtimeVersion !== execution.runtime_version)
  )
    return fail(
      "durable_handler_incompatible",
      "Retain the pinned workflow handler before resuming this run",
    );
  const allowed = await env.DB.prepare(live("'queued','running','waiting'"))
    .bind(runId, ...scope(identity), new Date().toISOString())
    .first();
  if (!allowed)
    return fail(
      "durable_execution_fenced",
      "Run authority, deadline or execution policy no longer permits progress",
    );
  return execution;
};

/** Atomically creates the canonical run and startup intent. No engine or request lifetime is involved. */
export const admitDurableExecution = async (
  env: Env,
  identity: AgentIdentity,
  incoming: {
    submissionKey: string;
    workflowType: string;
    workflowVersion: string;
    definitionHash: string;
    packId: string;
    packVersion: string;
    runtimeVersion: string;
    input: RuntimeRecord;
    maxSteps: number;
    maxDurationMs: number;
    maxActiveRuns: number;
  },
  invocation?: DurableTriggerInvocation,
) => {
  const input = structuredClone(incoming);
  for (const value of [
    input.submissionKey,
    input.workflowType,
    input.workflowVersion,
    input.packId,
    input.packVersion,
    input.runtimeVersion,
  ])
    if (!key(value))
      return fail("durable_request_invalid", "Durable identities must be bounded, stable keys");
  if (
    !/^[a-f0-9]{64}$/.test(input.definitionHash) ||
    !Number.isSafeInteger(input.maxSteps) ||
    input.maxSteps < 1 ||
    input.maxSteps > 128 ||
    !Number.isSafeInteger(input.maxDurationMs) ||
    input.maxDurationMs < 1 ||
    input.maxDurationMs > 604800000 ||
    !Number.isSafeInteger(input.maxActiveRuns) ||
    input.maxActiveRuns < 1 ||
    input.maxActiveRuns > 100
  )
    return fail("durable_request_invalid", "Durable execution bounds are invalid");
  const agent = await env.DB.prepare(actorAuthority)
    .bind(...scope(identity), identity.agentRevision ?? 0)
    .first<AgentRow>();
  if (!agent) return fail("durable_authority_revoked", "Current execution authority is required");
  const pack = resolveAgentBehaviorConfig(agent).pack;
  if (
    !pack ||
    pack.id !== input.packId ||
    pack.version !== input.packVersion ||
    !pack.workflows.some((workflow) => workflow.type === input.workflowType)
  )
    return fail("durable_pack_mismatch", "Submission does not match the canonical agent package");
  const inputJson = boundedJson(input.input, 32768),
    configHash = await configurationHash(env, agent);
  const requestHash = await hash([
    input,
    configHash,
    identity.agentRevision ?? 0,
    ...(invocation
      ? [
          {
            triggerId: invocation.triggerId,
            dispatchId: invocation.dispatchId,
            snapshot: invocation.triggerSnapshot,
          },
        ]
      : []),
  ]);
  // The scoped submission receipt supplies stable replay identity. New opaque IDs
  // prevent an old, delayed native deletion from targeting a recreated workspace's run.
  const runId = createId("durable"),
    intentId = createId("durable-intent");
  const replay = (previous: DurableExecution) => {
    if (previous.request_hash !== requestHash)
      return fail(
        "durable_submission_conflict",
        "Submission key was already used for different work",
      );
    return { accepted: false, execution: previous };
  };
  const previous = await readSubmission(env, identity, input.submissionKey);
  if (previous) return replay(previous);
  const relation = buildControlRunRelation({ runId });
  if (!relation.ok)
    return fail("durable_request_invalid", "Unable to create canonical run relation");
  const now = new Date().toISOString(),
    deadline = new Date(Date.now() + input.maxDurationMs).toISOString();
  const metadata = JSON.stringify({
    source: "durable-workflow",
    workflowType: input.workflowType,
    packId: input.packId,
    packVersion: input.packVersion,
    runtimeVersion: input.runtimeVersion,
    workflowVersion: input.workflowVersion,
    agentRevision: identity.agentRevision ?? 0,
    relation: relation.relation,
    logicalEventId: invocation?.dispatchId ?? runId,
    ...(invocation
      ? {
          triggerId: invocation.triggerId,
          triggerDispatchId: invocation.dispatchId,
          invocationSource: "trigger",
        }
      : {}),
    durableInstanceId: runId,
  });
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO control_durable_executions
        (run_id,user_id,workspace_id,agent_id,workflow_intent_id,instance_id,submission_key,request_hash,pack_id,pack_version,runtime_version,
         workflow_type,workflow_version,definition_hash,agent_revision,agent_data_json,configuration_hash,input_json,status,max_steps,deadline,created_at,updated_at,engine_lifecycle_version,deployment_id,preconditions_met)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,1,?,CASE WHEN EXISTS (${actorAuthority} AND a.data_json=?)
        AND NOT EXISTS (SELECT 1 FROM control_kill_switches WHERE user_id=? AND workspace_id=? AND enabled=1
          AND ((scope_kind='workspace' AND scope_id=?) OR (scope_kind='pack' AND scope_id=?)))
        AND (SELECT COUNT(*) FROM control_runs WHERE user_id=? AND workspace_id=? AND agent_id=?
          AND status IN ('queued','running','waiting','interrupted') AND json_extract(data_json,'$.packId')=?) < ?
        THEN 1 ELSE 0 END`).bind(
        runId,
        ...scope(identity),
        intentId,
        runId,
        input.submissionKey,
        requestHash,
        input.packId,
        input.packVersion,
        input.runtimeVersion,
        input.workflowType,
        input.workflowVersion,
        input.definitionHash,
        identity.agentRevision ?? 0,
        agent.data_json,
        configHash,
        inputJson,
        input.maxSteps,
        deadline,
        now,
        now,
        env.WORKBENCH_DEPLOYMENT_ID ?? "",
        ...scope(identity),
        identity.agentRevision ?? 0,
        agent.data_json,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.scope.workspaceId,
        input.packId,
        ...scope(identity),
        input.packId,
        input.maxActiveRuns,
      ),
      env.DB.prepare(`INSERT INTO control_workflow_intents (id,user_id,workspace_id,agent_id,stage,type,execution_json,payload_json,status,created_at,updated_at)
        VALUES (?,?,?,?,'execute',?,?,?,'queued',?,?)`).bind(
        intentId,
        ...scope(identity),
        input.workflowType,
        JSON.stringify({ mode: "dry_run", policy: "durable-workflow" }),
        JSON.stringify({ input: input.input, invocation: invocation ? "trigger" : "user" }),
        now,
        now,
      ),
      env.DB.prepare(`INSERT INTO control_runs (id,user_id,workspace_id,agent_id,workflow_intent_id,status,execution_json,stage,engine,data_json,created_at,updated_at)
        VALUES (?,?,?,?,?,'queued',?,'execute','cloudflare',?,?,?)`).bind(
        runId,
        ...scope(identity),
        intentId,
        JSON.stringify({ mode: "dry_run", policy: "durable-workflow" }),
        metadata,
        now,
        now,
      ),
      env.DB.prepare(`INSERT INTO control_plane_events (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
        VALUES (?,?,?,?,'workflow.accepted','Durable workflow accepted.','run',?,?,?)`).bind(
        `${runId}:accepted`,
        ...scope(identity),
        runId,
        metadata,
        now,
      ),
      ...(invocation
        ? [
            durableTriggerLinkStatement(
              env,
              identity,
              runId,
              input.workflowType,
              input.packId,
              invocation,
              now,
            ),
          ]
        : []),
    ]);
  } catch (error) {
    const concurrent = await readSubmission(env, identity, input.submissionKey);
    if (concurrent) return replay(concurrent);
    if (String(error).includes("workspace_export_in_progress"))
      return fail("workspace_export_in_progress", "Workspace export fences durable admission");
    if (String(error).includes("durable_deployment_in_progress"))
      return fail(
        "durable_deployment_in_progress",
        "A runtime deployment temporarily fences new durable submissions; retry the same submission key",
      );
    if (String(error).includes("durable_deployment_changed"))
      return fail(
        "durable_deployment_changed",
        "This Worker deployment no longer admits durable work; retry the same submission key",
      );
    return fail(
      "durable_admission_denied",
      "Authority, configuration or concurrency changed before durable admission",
    );
  }
  return { accepted: true, execution: (await readExecution(env, identity, runId))! };
};

export const startDurableExecution = async (
  env: Env,
  identity: AgentIdentity,
  runId: string,
  pins: { definitionHash: string; workflowVersion: string; runtimeVersion: string },
) => {
  const execution = await requireDurableExecutionAuthority(env, identity, runId, pins);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE control_durable_executions SET status='started',updated_at=?,preconditions_met=CASE WHEN EXISTS (${live("'queued','running'")}) THEN 1 ELSE 0 END
      WHERE run_id=? AND user_id=? AND workspace_id=? AND agent_id=?`).bind(
      now,
      runId,
      ...scope(identity),
      now,
      runId,
      ...scope(identity),
    ),
    env.DB.prepare(
      `UPDATE control_runs SET status='running',heartbeat_at=?,updated_at=? WHERE id=? AND EXISTS (${live("'queued','running'")})`,
    ).bind(now, now, runId, runId, ...scope(identity), now),
    env.DB.prepare(
      `UPDATE control_workflow_intents SET status='running',updated_at=? WHERE id=? AND EXISTS (${live()})`,
    ).bind(now, execution.workflow_intent_id, runId, ...scope(identity), now),
  ]);
  return requireDurableExecutionAuthority(env, identity, runId, pins);
};

export const claimDurableStep = async (
  env: Env,
  identity: AgentIdentity,
  runId: string,
  incoming: {
    key: string;
    version: string;
    payload: RuntimeRecord;
    outputSchema: JsonSchema;
    replaySafe: boolean;
    maxAttempts: number;
    timeoutMs: number;
  },
): Promise<
  | { execute: true; stepId: string; attemptId: string; attempt: number; expiresAt: string }
  | { execute: false; stepId: string; output: RuntimeRecord }
> => {
  const input = structuredClone(incoming);
  const execution = await requireDurableExecutionAuthority(env, identity, runId);
  if (
    !key(input.key) ||
    !key(input.version) ||
    typeof input.replaySafe !== "boolean" ||
    !Number.isSafeInteger(input.maxAttempts) ||
    input.maxAttempts < 1 ||
    input.maxAttempts > 5 ||
    (!input.replaySafe && input.maxAttempts !== 1) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 300000
  )
    return fail(
      "durable_step_invalid",
      "Steps require stable identities and bounded explicit replay policy",
    );
  assertSchemaDefinition(input.outputSchema, "durable step output");
  if (input.outputSchema.type !== "object")
    return fail("durable_step_invalid", "Step output must be an object");
  boundedJson(input.payload, 32768);
  const schema = boundedJson(input.outputSchema, 8192),
    requestHash = await hash(input),
    stepId = `step-${await hash([runId, input.key])}`;
  const previous = await readStep(env, identity, runId, stepId),
    now = new Date().toISOString();
  const replay = (step: DurableStep) => {
    if (step.request_hash !== requestHash)
      return fail(
        "durable_step_conflict",
        "A logical step was replayed with a different definition or input",
      );
    if (step.status === "completed")
      return { execute: false as const, stepId, output: JSON.parse(step.output_json!) };
    return undefined;
  };
  if (previous) {
    const cached = replay(previous);
    if (cached) return cached;
    if (previous.status === "running" && previous.expires_at > now)
      return fail("durable_step_in_progress", "The step attempt still holds execution authority");
    if (!input.replaySafe || previous.attempt_count >= input.maxAttempts) {
      if (previous.status === "running")
        await finishDurableStep(env, identity, runId, stepId, previous.active_attempt_id, {
          status: "outcome_unknown",
          errorCode: "step_interrupted",
        });
      return fail(
        "durable_step_requires_reconciliation",
        "The interrupted step cannot be safely replayed under its declared policy",
      );
    }
  }
  const attempt = (previous?.attempt_count ?? 0) + 1,
    attemptId = createId("durable-attempt");
  const expires = new Date(
    Math.min(Date.now() + input.timeoutMs, Date.parse(execution.deadline)),
  ).toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO control_durable_step_attempts (id,user_id,workspace_id,agent_id,run_id,step_id,attempt_index,status,started_at,preconditions_met)
        SELECT ?,?,?,?,?,?,?,'running',?, CASE WHEN EXISTS (${live()}) AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND ((?=0 AND NOT EXISTS (SELECT 1 FROM control_durable_steps WHERE id=?) AND (SELECT COUNT(*) FROM control_durable_steps WHERE run_id=?)<?)
          OR EXISTS (SELECT 1 FROM control_durable_steps WHERE id=? AND attempt_count=? AND request_hash=? AND replay_safe=1 AND attempt_count<max_attempts
            AND (status IN ('failed','outcome_unknown') OR (status='running' AND expires_at<=?)))) THEN 1 ELSE 0 END`).bind(
        attemptId,
        ...scope(identity),
        runId,
        stepId,
        attempt,
        now,
        runId,
        ...scope(identity),
        now,
        expires,
        previous?.attempt_count ?? 0,
        stepId,
        runId,
        execution.max_steps,
        stepId,
        previous?.attempt_count ?? 0,
        requestHash,
        now,
      ),
      ...(previous
        ? [
            env.DB.prepare(`UPDATE control_durable_step_attempts SET status='outcome_unknown',error_code='step_interrupted',finished_at=?
        WHERE id=? AND status='running'`).bind(now, previous.active_attempt_id),
          ]
        : []),
      env.DB.prepare(`INSERT INTO control_durable_steps (id,user_id,workspace_id,agent_id,run_id,step_key,step_version,request_hash,output_schema_json,replay_safe,max_attempts,timeout_ms,attempt_count,active_attempt_id,status,expires_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'running',?,?,?) ON CONFLICT(id) DO UPDATE SET attempt_count=excluded.attempt_count,active_attempt_id=excluded.active_attempt_id,status='running',expires_at=excluded.expires_at,updated_at=excluded.updated_at`).bind(
        stepId,
        ...scope(identity),
        runId,
        input.key,
        input.version,
        requestHash,
        schema,
        Number(input.replaySafe),
        input.maxAttempts,
        input.timeoutMs,
        attempt,
        attemptId,
        expires,
        now,
        now,
      ),
      env.DB.prepare(`INSERT INTO control_plane_events (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
        VALUES (?,?,?,?,'workflow.step.started','Durable step attempt started.','run',?,?,?)`).bind(
        attemptId,
        ...scope(identity),
        runId,
        JSON.stringify({ stepId, attemptId, attempt }),
        now,
      ),
    ]);
  } catch (error) {
    const concurrent = await readStep(env, identity, runId, stepId);
    if (concurrent) {
      const cached = replay(concurrent);
      if (cached) return cached;
    }
    if (String(error).includes("workspace_export_in_progress"))
      return fail("workspace_export_in_progress", "Workspace export fences durable steps");
    return fail(
      "durable_step_admission_denied",
      "Step authority, bounds or the current attempt changed before dispatch",
    );
  }
  return { execute: true, stepId, attemptId, attempt, expiresAt: expires };
};

/** Recording an outcome and publishing its event is atomic; a lost response may safely repeat this exact write. */
export const finishDurableStep = async (
  env: Env,
  identity: AgentIdentity,
  runId: string,
  stepId: string,
  attemptId: string,
  incoming: DurableStepOutcome,
) => {
  const outcome = structuredClone(incoming);
  await requireDurableExecutionAuthority(env, identity, runId);
  const step = await readStep(env, identity, runId, stepId);
  if (!step || step.active_attempt_id !== attemptId)
    return fail("durable_step_attempt_superseded", "This attempt no longer owns step publication");
  let output: string | null = null;
  if (outcome.status === "completed") {
    assertSchemaValue(JSON.parse(step.output_schema_json), outcome.output, "durable step output");
    output = boundedJson(outcome.output, 65536);
  } else if (!key(outcome.errorCode))
    return fail("durable_step_invalid", "A bounded error code is required");
  const outcomeHash = await hash(outcome),
    now = new Date().toISOString();
  if (step.outcome_hash === outcomeHash && step.status === outcome.status) return;
  const errorCode = outcome.status === "completed" ? null : outcome.errorCode;
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO control_durable_step_outcomes (id,user_id,workspace_id,agent_id,run_id,step_id,outcome_hash,status,created_at,preconditions_met)
        SELECT ?,?,?,?,?,?,?,?,?,CASE WHEN EXISTS (${live()})
        AND EXISTS (SELECT 1 FROM control_durable_steps s JOIN control_durable_step_attempts a ON a.id=s.active_attempt_id
          WHERE s.id=? AND s.run_id=? AND s.active_attempt_id=? AND s.status='running' AND a.status='running'
            AND a.step_id=s.id AND a.run_id=s.run_id AND a.user_id=s.user_id AND a.workspace_id=s.workspace_id AND a.agent_id=s.agent_id
            AND (?='outcome_unknown' OR (s.expires_at>? AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))) THEN 1 ELSE 0 END`).bind(
        attemptId,
        ...scope(identity),
        runId,
        stepId,
        outcomeHash,
        outcome.status,
        now,
        runId,
        ...scope(identity),
        now,
        stepId,
        runId,
        attemptId,
        outcome.status,
        now,
      ),
      env.DB.prepare(`UPDATE control_durable_step_attempts SET status=?,output_json=?,outcome_hash=?,error_code=?,finished_at=?
        WHERE id=? AND run_id=? AND user_id=? AND workspace_id=? AND agent_id=?`).bind(
        outcome.status,
        output,
        outcomeHash,
        errorCode,
        now,
        attemptId,
        runId,
        ...scope(identity),
      ),
      env.DB.prepare(
        "UPDATE control_durable_steps SET status=?,updated_at=? WHERE id=? AND active_attempt_id=?",
      ).bind(outcome.status, now, stepId, attemptId),
      env.DB.prepare(`INSERT INTO control_plane_events (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
        VALUES (?,?,?,?,'workflow.step.finished','Durable step outcome recorded.','run',?,?,?)`).bind(
        `${attemptId}:finished`,
        ...scope(identity),
        runId,
        JSON.stringify({ stepId, attemptId, status: outcome.status, errorCode }),
        now,
      ),
    ]);
  } catch (error) {
    const concurrent = await readStep(env, identity, runId, stepId);
    if (concurrent?.active_attempt_id === attemptId && concurrent.outcome_hash === outcomeHash)
      return;
    if (String(error).includes("workspace_export_in_progress"))
      return fail("workspace_export_in_progress", "Workspace export fences step publication");
    return fail(
      "durable_step_publication_denied",
      "Step publication lost authority or conflicts with a recorded outcome",
    );
  }
};

/** Engine-only lookup. HTTP callers must resolve canonical actor scope first. */
export const loadDurableExecution = (env: Env, runId: string) =>
  env.DB.prepare("SELECT * FROM control_durable_executions WHERE run_id=?")
    .bind(runId)
    .first<DurableExecution>();

export const loadDurableStepOutput = async (
  env: Env,
  identity: AgentIdentity,
  runId: string,
  stepId: string,
  definition?: import("@operloom/agent-sdk").RuntimeDurableStep,
) => {
  await requireDurableExecutionAuthority(env, identity, runId);
  const step = await readStep(env, identity, runId, stepId);
  if (!step || step.status !== "completed" || !step.output_json)
    return fail("durable_result_unavailable", "The completed step result is unavailable");
  if (definition && step.request_hash !== (await hash(definition)))
    return fail(
      "durable_step_conflict",
      "A cached step cannot be reused with changed inputs or definition",
    );
  return JSON.parse(step.output_json) as RuntimeRecord;
};

/** Terminal projection is atomic with its event. Repeating a completed projection never publishes twice. */
export const completeDurableExecution = async (
  env: Env,
  identity: AgentIdentity,
  runId: string,
  result: { ok: true; output: RuntimeRecord } | { ok: false; code: string },
  pins: { definitionHash: string; workflowVersion: string; runtimeVersion: string },
) => {
  const outcomeHash = await hash(result);
  const terminal = () =>
    env.DB.prepare(
      "SELECT status,json_extract(data_json,'$.durableOutcomeHash') outcome_hash FROM control_runs WHERE id=? AND user_id=? AND workspace_id=? AND agent_id=?",
    )
      .bind(runId, ...scope(identity))
      .first<{ status: string; outcome_hash: string | null }>();
  const recorded = await terminal();
  if (recorded && ["completed", "blocked", "failed", "cancelled"].includes(recorded.status)) {
    if (recorded.outcome_hash === outcomeHash) return;
    return fail("durable_outcome_conflict", "A terminal run cannot accept a different result");
  }
  let execution: DurableExecution;
  try {
    execution = await requireDurableExecutionAuthority(env, identity, runId, pins);
  } catch (error) {
    if ((await terminal())?.outcome_hash === outcomeHash) return;
    throw error;
  }
  const data = boundedJson(
    result.ok
      ? {
          durableOutcomeHash: outcomeHash,
          output: result.output,
          summary: "Durable workflow completed.",
        }
      : {
          durableOutcomeHash: outcomeHash,
          error: {
            code: result.code,
            message: "Durable workflow stopped; inspect its recorded steps.",
          },
        },
    65536,
  );
  const now = new Date().toISOString(),
    status = result.ok ? "completed" : "blocked";
  const values = [runId, ...scope(identity), now];
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE control_durable_executions SET preconditions_met=CASE WHEN EXISTS (${live("'queued','running'")}) THEN 1 ELSE 0 END
      WHERE run_id=? AND user_id=? AND workspace_id=? AND agent_id=?`).bind(
        ...values,
        runId,
        ...scope(identity),
      ),
      env.DB.prepare(`UPDATE control_workflow_intents SET status=?,updated_at=? WHERE id=?
      AND EXISTS (${live("'queued','running'")})`).bind(
        status,
        now,
        execution.workflow_intent_id,
        ...values,
      ),
      env.DB.prepare(`UPDATE control_runs SET status=?,updated_at=?,completed_at=?,failed_at=?,last_event_at=?,data_json=json_patch(data_json,?)
      WHERE id=? AND EXISTS (${live("'queued','running'")})`).bind(
        status,
        now,
        result.ok ? now : null,
        result.ok ? null : now,
        now,
        data,
        runId,
        ...values,
      ),
      env.DB.prepare(`INSERT INTO control_plane_events (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
      SELECT ?,?,?,?,?,'Durable workflow finished.','run',?,?,? WHERE EXISTS (
        SELECT 1 FROM control_durable_executions e JOIN control_runs r ON r.id=e.run_id
        WHERE e.run_id=? AND e.user_id=? AND e.workspace_id=? AND e.agent_id=? AND e.status='closed' AND r.status=? AND r.updated_at=?)`).bind(
        `${runId}:terminal`,
        ...scope(identity),
        `workflow.run.${status}`,
        runId,
        data,
        now,
        runId,
        ...scope(identity),
        status,
        now,
      ),
    ]);
  } catch (error) {
    if ((await terminal())?.outcome_hash !== outcomeHash) throw error;
  }
  if ((await terminal())?.outcome_hash !== outcomeHash)
    return fail("durable_execution_fenced", "Terminal projection lost execution authority");
};
