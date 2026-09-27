import { admitDurableExecution } from "./durable-execution-store";
import {
  durableWorkflowDefinitionHash,
  startDurableWorkflowEngine,
} from "./durable-workflow-runtime";
import { captureRuntimeContext, contextIsRequired, bindRuntimeContext } from "./runtime-context";
import { createRuntimeStatePort } from "./runtime-state";
import { createSimulationActionPort } from "./runtime-simulation";
import { createRuntimeModelPort } from "./runtime-models";
import { withRuntimeDeadline } from "./runtime-deadline";
import {
  assertSchemaValue,
  type AgentExecutionContext,
  type RuntimeResult,
  type RuntimeToolBinding,
  type RuntimeWorkflowBinding,
} from "@operloom/agent-sdk/control-plane";

import { packWorkflowBindings, resolvePackRuntime } from "../../../lib/agent-runtime/registry";
import { resolveAgentBehaviorConfig } from "./agent-records";
import { selectAgent } from "./authz-store";
import { appendControlPlaneEvent } from "./control-plane-events";
import { isRecord, json, parseJson } from "./http";
import { readManagedStateVersion, upsertManagedState } from "./managed-state";
import {
  finishPackWorkflowRun,
  recordPackWorkflowToolCall,
  startPackWorkflowRun,
} from "./runtime-run-lifecycle";
import type { WorkflowInvocationContext } from "./pack-workflow-runtime";
import { executeRuntimeToolBinding } from "./runtime-tool-execution";
import { effectTargetOf, type AgentIdentity, type Env } from "./types";
import { authorizeWorkflowTools } from "./workflow-tool-policy";
import { createBrokeredConnectionPort } from "./connection-broker";
import { createDurableActionPort } from "./action-authority";
import {
  claimDemoDailyUsage,
  demoPackAllowed,
  demoModeEnabled,
  requireDemoConcurrencyAvailable,
  requireDemoModelBudget,
} from "./demo-policy";

const runtimeError = (code: string, message: string, status = 400) =>
  json(
    {
      ok: false,
      error: message,
      details: { code, message, retryable: false, redacted: true },
    },
    { status },
  );

const failure = (error: unknown): RuntimeResult => ({
  ok: false,
  error: {
    code:
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "runtime_execution_failed",
    message: error instanceof Error ? error.message : "Runtime execution failed.",
    retryable: false,
    redacted: true,
  },
  summary: error instanceof Error ? error.message : "Runtime execution failed.",
});

const toolResult = (value: unknown): RuntimeResult => {
  if (value && typeof value === "object" && "ok" in value && typeof value.ok === "boolean") {
    return value as RuntimeResult;
  }
  return failure(
    Object.assign(new Error("Runtime tool returned an invalid result."), {
      code: "runtime_result_invalid",
    }),
  );
};

export const listRuntimeWorkflows = async (env: Env, identity: AgentIdentity) => {
  const agent = await selectAgent(env, identity.agentId, identity.scope.workspaceId);
  const pack = resolveAgentBehaviorConfig(agent).pack;
  if (pack && !demoPackAllowed(env, pack.id)) {
    return runtimeError("demo_pack_disabled", "This pack is unavailable in the public demo.", 403);
  }
  if (!pack) {
    return json({ ok: true, runnable: true, workflows: [] });
  }
  const runtime = resolvePackRuntime(pack.id, pack.version);
  if (!runtime.runnable) {
    return json({
      ok: true,
      packId: pack.id,
      packVersion: pack.version,
      runnable: false,
      reason: runtime.reason,
      workflows: [],
    });
  }
  const userInvocable = new Set(
    pack.workflows.filter((workflow) => workflow.userInvocable).map((workflow) => workflow.type),
  );
  return json({
    ok: true,
    packId: pack.id,
    packVersion: pack.version,
    runtimeVersion: runtime.runtimeVersion,
    runnable: true,
    workflows: runtime.controlPlane.workflows
      .filter((workflow) => userInvocable.has(workflow.type))
      .map((workflow) => ({
        type: workflow.type,
        label: workflow.label,
        description: workflow.description,
        inputSchema: workflow.inputSchema,
        outputSchema: workflow.outputSchema,
        toolIds: workflow.toolIds,
        runDisplayName: workflow.runDisplayName,
      })),
  });
};

export const executeRuntimeWorkflowRequest = async (
  workflowType: string,
  request: Request,
  env: Env,
  identity: AgentIdentity,
  invocation: WorkflowInvocationContext,
) => {
  const binding = packWorkflowBindings[workflowType];
  if (!binding) return runtimeError("workflow_not_found", "Workflow not found.", 404);
  const agent = await selectAgent(env, identity.agentId, identity.scope.workspaceId);
  // Pin the same row used to resolve executable code, including scheduler requests.
  identity = {
    ...identity,
    agentRevision: agent?.runtime_revision ?? 0,
    effectTarget: agent?.effect_target ?? "simulation",
  };
  const pack = resolveAgentBehaviorConfig(agent).pack;
  if (!pack || pack.id !== binding.requiredPackId) {
    return runtimeError(
      "pack_required",
      `${workflowType} requires the active ${binding.requiredPackId} pack.`,
      403,
    );
  }
  if (!demoPackAllowed(env, pack.id)) {
    return runtimeError("demo_pack_disabled", "This pack is unavailable in the public demo.", 403);
  }
  const runtime = resolvePackRuntime(pack.id, pack.version);
  if (!runtime.runnable) {
    return runtimeError(
      runtime.reason,
      "message" in runtime
        ? (runtime.message ?? "Runtime requirements are incompatible.")
        : "This agent snapshot can chat, but its workflows require a compatible runtime upgrade.",
      409,
    );
  }
  const workflow = runtime.controlPlane.workflows.find(
    (candidate) => candidate.type === workflowType,
  ) as RuntimeWorkflowBinding | undefined;
  if (!workflow || (!workflow.execute && !workflow.durable)) {
    return runtimeError(
      "workflow_binding_unavailable",
      "Workflow implementation is unavailable.",
      409,
    );
  }
  const body = parseJson(await request.text());
  if (!isRecord(body)) return runtimeError("invalid_input", "Body must be an object.");
  if (body.executionMode !== undefined && body.executionMode !== "dry_run") {
    return runtimeError("unsupported_execution_mode", "Only dry_run is supported.");
  }
  const execution = isRecord(body.input) ? body.execution : undefined;
  const rawInput = isRecord(body.input) ? body.input : body;
  const input = workflow.normalizeInput ? workflow.normalizeInput(rawInput) : rawInput;
  try {
    assertSchemaValue(workflow.inputSchema, input, `${workflowType} input`);
  } catch (error) {
    return runtimeError(
      "schema_validation_failed",
      error instanceof Error ? error.message : "Workflow input is invalid.",
    );
  }
  if (execution === "durable") {
    if (!workflow.durable)
      return runtimeError(
        "workflow_binding_unavailable",
        "This workflow has no durable implementation.",
        409,
      );
    if (!env.DURABLE_WORKFLOWS)
      return runtimeError(
        "durable_binding_missing",
        "The durable workflow engine binding is not configured.",
        503,
      );
    if (demoModeEnabled(env) || (invocation.source === "trigger" && !invocation.triggerSnapshot))
      return runtimeError(
        "durable_source_unsupported",
        "Durable admission requires a supported source and canonical trigger snapshot.",
        409,
      );
    const submissionKey =
      invocation.source === "trigger"
        ? `trigger:${invocation.dispatchId}`
        : request.headers.get("idempotency-key");
    if (!submissionKey)
      return runtimeError(
        "idempotency_key_required",
        "Durable submissions require an Idempotency-Key header.",
      );
    try {
      const admitted = await admitDurableExecution(
        env,
        identity,
        {
          submissionKey,
          workflowType,
          workflowVersion: workflow.durable.version,
          definitionHash: await durableWorkflowDefinitionHash(runtime, workflow),
          packId: pack.id,
          packVersion: pack.version,
          runtimeVersion: runtime.runtimeVersion,
          input,
          maxSteps: workflow.durable.maxSteps,
          maxDurationMs: workflow.durable.maxDurationMs,
          maxActiveRuns: pack.resourceLimits.maxConcurrentRuns,
        },
        invocation.source === "trigger" ? invocation : undefined,
      );
      await startDurableWorkflowEngine(env, admitted.execution).catch(() => undefined);
      const canonicalRun = await env.DB.prepare(
        "SELECT status FROM control_runs WHERE id=? AND user_id=? AND workspace_id=? AND agent_id=?",
      )
        .bind(
          admitted.execution.run_id,
          identity.scope.userId,
          identity.scope.workspaceId,
          identity.agentId,
        )
        .first<{ status: string }>();
      return json(
        {
          ok: true,
          accepted: admitted.accepted,
          run: {
            id: admitted.execution.run_id,
            workflowIntentId: admitted.execution.workflow_intent_id,
            workflowType,
            engine: "cloudflare-workflows",
            status: canonicalRun?.status ?? "queued",
          },
        },
        { status: 202 },
      );
    } catch (error) {
      return runtimeError(
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "durable_admission_failed",
        "Durable submission could not be accepted.",
        409,
      );
    }
  }
  if (execution !== undefined && execution !== "request")
    return runtimeError("unsupported_execution", "Execution must be request or durable.");
  if (!workflow.execute)
    return runtimeError(
      "workflow_binding_unavailable",
      "This workflow requires durable execution.",
      409,
    );
  const budgetResponse = await requireDemoModelBudget(env);
  if (budgetResponse) return budgetResponse;
  for (const toolId of workflow.toolIds) {
    const tool = runtime.controlPlane.tools.find((candidate) => candidate.id === toolId);
    if (!tool) {
      return runtimeError(
        "tool_binding_unavailable",
        `Workflow tool ${toolId} is not registered.`,
        409,
      );
    }
    const authorization = await authorizeWorkflowTools(env, identity, {
      toolNames: [toolId],
      executionMode: "dry_run",
      requestedRuntimeMs: tool.timeoutMs,
      requestedArtifactBytes: tool.maxArtifactBytes,
    });
    if (!authorization.ok) return authorization.response;
  }

  const active = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM control_runs
     WHERE user_id = ? AND workspace_id = ? AND agent_id = ?
       AND status IN ('queued', 'running', 'waiting', 'interrupted')
       AND json_extract(data_json, '$.packId') = ?`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, identity.agentId, pack.id)
    .first<{ count: number }>();
  if ((active?.count ?? 0) >= pack.resourceLimits.maxConcurrentRuns) {
    return runtimeError("concurrency_limit_exceeded", "The pack concurrency limit is active.", 429);
  }

  const concurrencyResponse = await requireDemoConcurrencyAvailable(env, identity);
  if (concurrencyResponse) return concurrencyResponse;

  const quotaResponse = await claimDemoDailyUsage(env, identity, "workflow");
  if (quotaResponse) return quotaResponse;

  const started = await startPackWorkflowRun(env, identity, {
    workflowType,
    policyReference: `runtime:${pack.id}:${runtime.runtimeVersion}`,
    displayName: workflow.runDisplayName ?? workflow.label,
    packId: pack.id,
    toolInput: input,
    executionMode: "dry_run",
    engine: "cloudflare",
    invocation,
    runtimeMetadata: {
      packVersion: pack.version,
      runtimeVersion: runtime.runtimeVersion,
      bindingVersion: 1,
      transports: Array.from(
        new Set(
          workflow.toolIds.map((toolId) => {
            const tool = runtime.controlPlane.tools.find((candidate) => candidate.id === toolId);
            return tool?.transport ?? "unknown";
          }),
        ),
      ),
    },
  });
  const controller = new AbortController();
  let calls = 0;

  const invokeTool = async (toolId: string, toolInput: Record<string, unknown>) => {
    controller.signal.throwIfAborted();
    calls += 1;
    const toolCallId = `${started.runId}-tool-${toolId.replaceAll(".", "-")}-${calls}`;
    if (calls > pack.resourceLimits.maxToolCallsPerRun) {
      return failure(
        Object.assign(new Error("Tool-call limit exceeded."), {
          code: "tool_call_limit_exceeded",
        }),
      );
    }
    const inline = runtime.controlPlane.tools.find((tool) => tool.id === toolId);
    const tool: RuntimeToolBinding | undefined = inline;
    if (!tool) {
      return failure(
        Object.assign(new Error(`Tool ${toolId} is not registered.`), {
          code: "tool_binding_unavailable",
        }),
      );
    }
    const result = await executeRuntimeToolBinding({
      env,
      identity,
      binding: tool,
      toolInput,
      context,
      execution: {
        runId: started.runId,
        workflowIntentId: started.workflowIntentId,
        toolCallId,
        packVersion: pack.version,
        runtimeVersion: runtime.runtimeVersion,
        bindingVersion: 1,
        callbackUrl:
          env.OPERLOOM_CALLBACK_URL ?? `${new URL(request.url).origin}/workbench/run-callbacks`,
        source: "agent-pack",
      },
    });
    await recordPackWorkflowToolCall(env, identity, {
      ...started,
      toolCallId,
      toolName: toolId,
      status: result.ok ? "completed" : "failed",
      inputSummary: `Invoke ${toolId}`,
      outputSummary: result.summary,
      data: {
        packId: pack.id,
        packVersion: pack.version,
        runtimeVersion: runtime.runtimeVersion,
        adapterVersion: tool.adapterVersion,
        transport: tool.transport,
        ...(result.ok ? { output: result.output } : { error: result.error }),
      },
    });
    return result;
  };

  const context: AgentExecutionContext = {
    scope: { ...identity.scope, agentId: identity.agentId },
    pack: { id: pack.id, version: pack.version, runtimeVersion: runtime.runtimeVersion },
    run: {
      id: started.runId,
      workflowIntentId: started.workflowIntentId,
      executionMode: "dry_run",
      source: invocation.source === "trigger" ? "trigger" : "user",
    },
    signal: controller.signal,
    connections: createBrokeredConnectionPort(env, identity, pack.connections),
    actions: createDurableActionPort(env, identity, {
      packId: pack.id,
      packVersion: pack.version,
      runtimeVersion: runtime.runtimeVersion,
      bindingVersion: 1,
      runId: started.runId,
      workflowIntentId: started.workflowIntentId,
    }),
    tools: { invoke: invokeTool },
    state: await createRuntimeStatePort(env, identity, {
      packId: pack.id,
      target: effectTargetOf(identity),
      definitions: runtime.controlPlane.state ?? [],
      signal: controller.signal,
      runId: started.runId,
    }),
    managedState: {
      async upsert(state) {
        controller.signal.throwIfAborted();
        const expectedVersion =
          state.expectedVersion ??
          (await readManagedStateVersion(env, identity, {
            namespace: state.namespace,
            stateType: state.stateType,
            stateKey: state.stateKey,
          }));
        controller.signal.throwIfAborted();
        const result = await upsertManagedState(env, identity, {
          ...state,
          expectedVersion,
        });
        if (!result.ok) {
          throw Object.assign(new Error("Managed-state compare-and-set conflict."), {
            code: "managed_state_version_conflict",
          });
        }
        return { id: result.state.id, version: result.state.version };
      },
    },
    events: {
      async append(type, summary, data) {
        controller.signal.throwIfAborted();
        await appendControlPlaneEvent(env, identity, {
          type,
          summary,
          targetType: "run",
          targetId: started.runId,
          data: { runId: started.runId, runtimeVersion: runtime.runtimeVersion, ...data },
        });
      },
    },
  };
  context.actions.simulate = createSimulationActionPort(env, identity, {
    context,
    toolIds: workflow.toolIds,
  });

  let result: RuntimeResult;
  try {
    result = toolResult(
      await withRuntimeDeadline(controller, pack.resourceLimits.maxRunSeconds * 1_000, async () => {
        if (contextIsRequired(runtime)) {
          const evidence = await captureRuntimeContext(env, identity, {
            runId: started.runId,
            runKind: "workflow",
            input,
            target: effectTargetOf(identity),
            signal: controller.signal,
          });
          if (evidence) {
            bindRuntimeContext(context, evidence);
            evidence.assertReady();
            if (context.state)
              context.state = await createRuntimeStatePort(env, identity, {
                packId: pack.id,
                target: effectTargetOf(identity),
                definitions: runtime.controlPlane.state ?? [],
                signal: controller.signal,
                runId: started.runId,
                contextSnapshotId: evidence.snapshot.id,
              });
          }
        }
        if (runtime.controlPlane.requirements.capabilities.includes("models.structured"))
          context.models = createRuntimeModelPort(env, identity, {
            runId: started.runId,
            signal: controller.signal,
            context: context.context,
          });
        return workflow.execute!(input, context);
      }),
    );
    if (result.ok)
      assertSchemaValue(workflow.outputSchema, result.output, `${workflowType} output`);
  } catch (error) {
    result = failure(error);
  }
  const runtimeArtifacts = result.artifacts ?? [];
  const artifactBytes = runtimeArtifacts.reduce(
    (total, artifact) => total + JSON.stringify(artifact.data).length,
    0,
  );
  if (artifactBytes > pack.resourceLimits.maxArtifactBytes) {
    result = failure(
      Object.assign(new Error("Artifact limit exceeded."), {
        code: "artifact_limit_exceeded",
      }),
    );
  }
  const artifacts = runtimeArtifacts.map((artifact, index) => ({
    id: `${started.runId}-${artifact.kind}${index ? `-${index + 1}` : ""}`,
    kind: artifact.kind,
    uri: `d1://control-plane/${started.runId}/${artifact.kind}${index ? `-${index + 1}` : ""}.json`,
    title: artifact.title,
    mimeType: artifact.mimeType,
    sizeBytes: JSON.stringify(artifact.data).length,
    data: artifact.data,
  }));
  const blocked =
    !result.ok &&
    ["context_blocked", "budget_not_configured", "resource_admission_denied"].includes(
      result.error.code,
    );
  const finished = await finishPackWorkflowRun(env, identity, {
    ...started,
    workflowType,
    ok: result.ok,
    blocked,
    summary: result.summary,
    artifacts: result.ok ? artifacts : undefined,
    data: {
      packId: pack.id,
      packVersion: pack.version,
      runtimeVersion: runtime.runtimeVersion,
      workflowType,
      toolCallCount: calls,
      ...(result.ok ? { output: result.output } : { error: result.error }),
    },
  });
  if (!finished.applied) {
    return runtimeError(
      "run_terminal",
      "Run output was discarded because publication authority was revoked.",
      409,
    );
  }
  return json(
    {
      ok: result.ok,
      run: {
        id: started.runId,
        workflowIntentId: started.workflowIntentId,
        status: result.ok ? "completed" : blocked ? "blocked" : "failed",
        engine: "cloudflare",
        workflowType,
        runtimeVersion: runtime.runtimeVersion,
      },
      ...(result.ok && artifacts[0]
        ? {
            artifact: {
              id: artifacts[0].id,
              kind: artifacts[0].kind,
              uri: artifacts[0].uri,
              title: artifacts[0].title,
              mimeType: artifacts[0].mimeType,
            },
          }
        : {}),
      ...(result.ok
        ? { report: result.output }
        : { error: result.error.message, code: result.error.code }),
    },
    { status: result.ok ? 201 : blocked ? 409 : 502 },
  );
};
