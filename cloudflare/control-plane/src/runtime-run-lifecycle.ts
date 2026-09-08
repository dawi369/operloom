import { registerRuntimeDeadline } from "./runtime-watchdog";
import { buildControlRunRelation, toControlRunRelationEventData } from "./run-relations";
import type { ControlRunRelation } from "./run-relations";
import type { WorkflowInvocationContext } from "./pack-workflow-runtime";
import { createId, toJson, type AgentIdentity, type Env, type ExecutionMode } from "./types";
import { packWorkflowBindings, resolveRuntimeTool } from "../../../lib/agent-runtime/registry";
import { agentManifestRegistry } from "../../../generated/agent-runtime/manifests";

export type RuntimeRunIdentity = {
  runId: string;
  workflowIntentId: string;
  relation: ControlRunRelation;
};

export class TriggerDispatchLeaseLostError extends Error {
  readonly code = "trigger_dispatch_lease_lost";

  constructor() {
    super("trigger_dispatch_lease_lost");
    this.name = "TriggerDispatchLeaseLostError";
  }
}

type PackWorkflowArtifact = {
  id: string;
  kind: string;
  uri: string;
  title: string;
  mimeType: string;
  sizeBytes: number;
  data: Record<string, unknown>;
  staged?: boolean;
};

type StartPackWorkflowInput = {
  workflowType: string;
  policyReference: string;
  displayName: string;
  packId: string;
  toolInput: Record<string, unknown>;
  executionMode: ExecutionMode;
  stage?: string;
  engine: "cloudflare" | "langgraph";
  invocation?: WorkflowInvocationContext;
  source?: string;
  intentCreatedSummary?: string;
  runtimeMetadata?: Record<string, unknown>;
};

type RecordToolCallInput = RuntimeRunIdentity & {
  toolCallId?: string;
  toolName: string;
  status: "completed" | "failed";
  inputSummary: string;
  outputSummary: string;
  data: Record<string, unknown>;
};

type FinishPackWorkflowInput = RuntimeRunIdentity & {
  workflowType: string;
  ok: boolean;
  summary: string;
  artifact?: PackWorkflowArtifact;
  artifacts?: PackWorkflowArtifact[];
  artifactCreatedSummary?: string;
  data: Record<string, unknown>;
};

const packWorkflowToolCallId = (runId: string, toolName: string) =>
  `${runId}-tool-${toolName.replaceAll(".", "-")}`;

export const startPackWorkflowRun = async (
  env: Env,
  identity: AgentIdentity,
  input: StartPackWorkflowInput,
): Promise<RuntimeRunIdentity> => {
  const timestamp = new Date().toISOString();
  const workflowIntentId = createId("cf-intent");
  const runId = createId("cf-run");
  const builtRelation = buildControlRunRelation({ runId });
  if (!builtRelation.ok) throw new Error(builtRelation.reason);

  const relation = builtRelation.relation;
  const relationData = toControlRunRelationEventData(relation);
  const stage = input.stage ?? "analyze";
  const engine = input.engine;
  const source = input.source ?? "agent-pack";
  const invocation = input.invocation ?? { source: "user" };
  const summary = input.intentCreatedSummary ?? `Created ${input.displayName} workflow intent.`;
  const execution = { mode: input.executionMode, policy: input.policyReference };
  const binding = packWorkflowBindings[input.workflowType];
  const manifest =
    agentManifestRegistry[input.packId as keyof typeof agentManifestRegistry]?.module;
  const runtimeMetadata = binding
    ? {
        packVersion: manifest?.version,
        runtimeVersion: binding.runtimeVersion,
        bindingVersion: 1,
        transports: Array.from(
          new Set(
            binding.toolIds
              .map((toolId) => resolveRuntimeTool(toolId)?.tool.transport)
              .filter((transport): transport is "cloudflare_inline" | "fly" => Boolean(transport)),
          ),
        ),
      }
    : {};
  const triggerData =
    invocation.source === "trigger"
      ? {
          trigger: {
            triggerId: invocation.triggerId,
            dispatchId: invocation.dispatchId,
            source: invocation.triggerSource,
            attemptCount: invocation.attemptCount,
            idempotencyKey: invocation.idempotencyKey,
            scheduledFor: invocation.scheduledFor,
          },
          ...(invocation.previousRunId ? { retryOfRunId: invocation.previousRunId } : {}),
        }
      : {};

  const intentPayload = toJson({
    input: input.toolInput,
    invocation: invocation.source,
    ...triggerData,
  });
  const runData = toJson({
    displayName: input.displayName,
    workflowType: input.workflowType,
    source: invocation.source === "trigger" ? "trigger" : source,
    packId: input.packId,
    relation,
    ...runtimeMetadata,
    ...input.runtimeMetadata,
    ...triggerData,
  });
  const auditData = toJson({
    eventName: "intent.created",
    runId,
    workflowIntentId,
    relation: relationData,
    ...triggerData,
  });
  const eventData = toJson({
    runId,
    workflowIntentId,
    workflowType: input.workflowType,
    relation: relationData,
    ...triggerData,
  });

  if (invocation.source === "trigger") {
    const dispatchGuard = `SELECT 1 FROM control_trigger_dispatches
      WHERE id = ? AND trigger_id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?
        AND status = 'running' AND lease_owner = ? AND run_id = ?`;
    const guardValues = [
      invocation.dispatchId,
      invocation.triggerId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      invocation.leaseOwner,
      runId,
    ];
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE control_trigger_dispatches
         SET status = 'running', run_id = ?, heartbeat_at = ?, updated_at = ?
         WHERE id = ? AND trigger_id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?
           AND status = 'leased' AND lease_owner = ? AND run_id IS NULL
           AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
      ).bind(
        runId,
        timestamp,
        timestamp,
        invocation.dispatchId,
        invocation.triggerId,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        invocation.leaseOwner,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO control_workflow_intents (
         id, user_id, workspace_id, agent_id, stage, type, execution_json, payload_json,
         status, created_at, updated_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${dispatchGuard})`,
      ).bind(
        workflowIntentId,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        stage,
        input.workflowType,
        toJson(execution),
        intentPayload,
        "running",
        timestamp,
        timestamp,
        ...guardValues,
      ),
      env.DB.prepare(
        `INSERT INTO control_runs (
         id, user_id, workspace_id, agent_id, workflow_intent_id, status, execution_json,
         stage, engine, heartbeat_at, last_event_at, data_json, created_at, updated_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${dispatchGuard})`,
      ).bind(
        runId,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        workflowIntentId,
        "running",
        toJson(execution),
        stage,
        engine,
        timestamp,
        timestamp,
        runData,
        timestamp,
        timestamp,
        ...guardValues,
      ),
      env.DB.prepare(
        `INSERT INTO control_audit_events (
         id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${dispatchGuard})`,
      ).bind(
        createId("cf-audit"),
        identity.scope.userId,
        identity.scope.workspaceId,
        "intent.created",
        summary,
        "workflowIntent",
        workflowIntentId,
        auditData,
        timestamp,
        ...guardValues,
      ),
      env.DB.prepare(
        `INSERT INTO control_plane_events (
         id, user_id, workspace_id, agent_id, type, summary, target_type, target_id,
         data_json, created_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${dispatchGuard})`,
      ).bind(
        createId("cf-event"),
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        "workflow.intent.created",
        summary,
        "workflowIntent",
        workflowIntentId,
        eventData,
        timestamp,
        ...guardValues,
      ),
    ]);

    if ((results[0]?.meta?.changes ?? 0) !== 1) {
      throw new TriggerDispatchLeaseLostError();
    }
    return { runId, workflowIntentId, relation };
  }

  await registerRuntimeDeadline(env, {
    identity,
    run: { runId, workflowIntentId, relation },
    workflowType: input.workflowType,
    deadline: Date.now() + ((manifest?.resourceLimits.maxRunSeconds ?? 30) + 15) * 1_000,
  });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO control_workflow_intents (
       id, user_id, workspace_id, agent_id, stage, type, execution_json, payload_json,
       status, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      workflowIntentId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      stage,
      input.workflowType,
      toJson(execution),
      intentPayload,
      "running",
      timestamp,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO control_runs (
       id, user_id, workspace_id, agent_id, workflow_intent_id, status, execution_json,
       stage, engine, heartbeat_at, last_event_at, data_json, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      runId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      workflowIntentId,
      "running",
      toJson(execution),
      stage,
      engine,
      timestamp,
      timestamp,
      runData,
      timestamp,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO control_audit_events (
         id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      createId("cf-audit"),
      identity.scope.userId,
      identity.scope.workspaceId,
      "intent.created",
      summary,
      "workflowIntent",
      workflowIntentId,
      auditData,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO control_plane_events (
         id, user_id, workspace_id, agent_id, type, summary, target_type, target_id,
         data_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      createId("cf-event"),
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      "workflow.intent.created",
      summary,
      "workflowIntent",
      workflowIntentId,
      eventData,
      timestamp,
    ),
  ]);

  return { runId, workflowIntentId, relation };
};

export const recordPackWorkflowToolCall = async (
  env: Env,
  identity: AgentIdentity,
  input: RecordToolCallInput,
) => {
  const timestamp = new Date().toISOString();
  const id = input.toolCallId ?? packWorkflowToolCallId(input.runId, input.toolName);
  await env.DB.prepare(
    `INSERT INTO control_tool_calls (
       id, user_id, workspace_id, agent_id, workflow_intent_id, run_id, tool_id, status,
       input_summary, output_summary, artifact_refs_json, data_json, started_at, finished_at,
       created_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM control_runs
       WHERE user_id = ? AND workspace_id = ? AND id = ?
         AND status IN ('queued', 'running', 'waiting', 'interrupted')
     )
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       output_summary = excluded.output_summary,
       data_json = json_patch(control_tool_calls.data_json, excluded.data_json),
       finished_at = excluded.finished_at`,
  )
    .bind(
      id,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      input.workflowIntentId,
      input.runId,
      input.toolName,
      input.status,
      input.inputSummary,
      input.outputSummary,
      "[]",
      toJson(input.data),
      timestamp,
      timestamp,
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      input.runId,
    )
    .run();
  return id;
};

export const finishPackWorkflowRun = async (
  env: Env,
  identity: AgentIdentity,
  input: FinishPackWorkflowInput,
): Promise<{ applied: boolean }> => {
  const timestamp = new Date().toISOString();
  const artifacts = input.artifacts ?? (input.artifact ? [input.artifact] : []);
  const artifactRefs = artifacts.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    uri: artifact.uri,
    title: artifact.title,
    mimeType: artifact.mimeType,
  }));

  const statements = [];
  for (const artifact of artifacts) {
    if (artifact.staged) continue;
    statements.push(
      env.DB.prepare(
        `INSERT INTO control_artifacts (
         id, user_id, workspace_id, kind, uri, title, mime_type, size_bytes, data_json, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM control_runs
         WHERE user_id = ? AND workspace_id = ? AND id = ?
           AND status IN ('queued', 'running', 'waiting', 'interrupted')
       )`,
      ).bind(
        artifact.id,
        identity.scope.userId,
        identity.scope.workspaceId,
        artifact.kind,
        artifact.uri,
        artifact.title,
        artifact.mimeType,
        artifact.sizeBytes,
        toJson(artifact.data),
        timestamp,
        identity.scope.userId,
        identity.scope.workspaceId,
        input.runId,
      ),
    );
  }
  if (artifactRefs.length) {
    statements.push(
      env.DB.prepare(
        `UPDATE control_tool_calls
         SET artifact_refs_json = ?
         WHERE user_id = ? AND workspace_id = ? AND run_id = ?
           AND EXISTS (
             SELECT 1 FROM control_runs
             WHERE user_id = ? AND workspace_id = ? AND id = ?
               AND status IN ('queued', 'running', 'waiting', 'interrupted')
           )`,
      ).bind(
        toJson(artifactRefs),
        identity.scope.userId,
        identity.scope.workspaceId,
        input.runId,
        identity.scope.userId,
        identity.scope.workspaceId,
        input.runId,
      ),
    );
  }

  statements.push(
    env.DB.prepare(
      `UPDATE control_artifacts
       SET data_json = json_set(data_json, '$.publicationStatus', 'published')
       WHERE user_id = ? AND workspace_id = ? AND id LIKE ?
         AND json_extract(data_json, '$.publicationStatus') = 'staged'
         AND EXISTS (
           SELECT 1 FROM control_runs
           WHERE user_id = ? AND workspace_id = ? AND id = ?
             AND status IN ('queued', 'running', 'waiting', 'interrupted')
         )`,
    ).bind(
      identity.scope.userId,
      identity.scope.workspaceId,
      `${input.runId}-%`,
      identity.scope.userId,
      identity.scope.workspaceId,
      input.runId,
    ),
  );

  statements.push(
    env.DB.prepare(
      `UPDATE control_workflow_intents
       SET status = ?, updated_at = ?
       WHERE user_id = ? AND workspace_id = ? AND id = ?
         AND EXISTS (
           SELECT 1 FROM control_runs
           WHERE user_id = ? AND workspace_id = ? AND id = ?
             AND status IN ('queued', 'running', 'waiting', 'interrupted')
         )`,
    ).bind(
      input.ok ? "completed" : "failed",
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      input.workflowIntentId,
      identity.scope.userId,
      identity.scope.workspaceId,
      input.runId,
    ),
    env.DB.prepare(
      `UPDATE control_runs
       SET status = ?, last_event_at = ?, completed_at = ?, failed_at = ?,
           data_json = json_patch(data_json, ?),
           updated_at = ?
       WHERE user_id = ? AND workspace_id = ? AND id = ?
         AND status IN ('queued', 'running', 'waiting', 'interrupted')`,
    ).bind(
      input.ok ? "completed" : "failed",
      timestamp,
      input.ok ? timestamp : null,
      input.ok ? null : timestamp,
      toJson({
        summary: input.summary,
        ...input.data,
        artifactIds: artifactRefs.map((artifact) => artifact.id),
      }),
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      input.runId,
    ),
  );
  const runResultIndex = statements.length - 1;
  const terminalStatus = input.ok ? "completed" : "failed";
  statements.push(
    env.DB.prepare(
      `UPDATE control_trigger_dispatches
       SET status = ?, heartbeat_at = ?, lease_owner = NULL, lease_expires_at = NULL,
           error_json = ?, updated_at = ?
       WHERE user_id = ? AND workspace_id = ? AND agent_id = ? AND run_id = ?
         AND status = 'running'
         AND EXISTS (
           SELECT 1 FROM control_runs
           WHERE user_id = ? AND workspace_id = ? AND id = ? AND status = ? AND updated_at = ?
         )`,
    ).bind(
      terminalStatus,
      timestamp,
      input.ok ? "{}" : toJson({ code: "workflow_failed", message: input.summary }),
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      input.runId,
      identity.scope.userId,
      identity.scope.workspaceId,
      input.runId,
      terminalStatus,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO control_audit_events (
         id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM control_runs
         WHERE user_id = ? AND workspace_id = ? AND id = ? AND status = ? AND updated_at = ?
       )`,
    ).bind(
      createId("cf-audit"),
      identity.scope.userId,
      identity.scope.workspaceId,
      input.ok ? "run.completed" : "run.failed",
      input.summary,
      "run",
      input.runId,
      toJson({
        eventName: input.ok ? "run.completed" : "run.failed",
        runId: input.runId,
        workflowIntentId: input.workflowIntentId,
        ...input.data,
      }),
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      input.runId,
      terminalStatus,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO control_plane_events (
         id, user_id, workspace_id, agent_id, type, summary, target_type, target_id,
         data_json, created_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM control_runs
         WHERE user_id = ? AND workspace_id = ? AND id = ? AND status = ? AND updated_at = ?
       )`,
    ).bind(
      createId("cf-event"),
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      input.ok ? "workflow.run.completed" : "workflow.run.failed",
      input.summary,
      "run",
      input.runId,
      toJson({
        runId: input.runId,
        workflowIntentId: input.workflowIntentId,
        workflowType: input.workflowType,
        artifactId: artifactRefs[0]?.id,
      }),
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      input.runId,
      terminalStatus,
      timestamp,
    ),
  );
  for (const artifactRef of artifactRefs) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO control_audit_events (
           id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM control_runs
           WHERE user_id = ? AND workspace_id = ? AND id = ? AND status = ? AND updated_at = ?
         )`,
      ).bind(
        createId("cf-audit"),
        identity.scope.userId,
        identity.scope.workspaceId,
        "artifact.created",
        input.artifactCreatedSummary ?? "Created workflow artifact.",
        "artifact",
        artifactRef.id,
        toJson({
          eventName: "artifact.created",
          runId: input.runId,
          workflowIntentId: input.workflowIntentId,
        }),
        timestamp,
        identity.scope.userId,
        identity.scope.workspaceId,
        input.runId,
        terminalStatus,
        timestamp,
      ),
    );
  }
  const results = await env.DB.batch(statements);
  if (results[runResultIndex]?.meta?.changes === 0) return { applied: false };
  return { applied: true };
};
