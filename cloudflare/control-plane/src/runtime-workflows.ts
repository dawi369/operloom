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
import type { AgentIdentity, Env } from "./types";
import { authorizeWorkflowTools } from "./workflow-tool-policy";
import { createBrokeredConnectionPort } from "./connection-broker";
import { createDurableActionPort } from "./action-authority";

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
        engine: workflow.engine,
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
  const pack = resolveAgentBehaviorConfig(agent).pack;
  if (!pack || pack.id !== binding.requiredPackId) {
    return runtimeError(
      "pack_required",
      `${workflowType} requires the active ${binding.requiredPackId} pack.`,
      403,
    );
  }
  const runtime = resolvePackRuntime(pack.id, pack.version);
  if (!runtime.runnable) {
    return runtimeError(
      runtime.reason,
      "This agent snapshot can chat, but its workflows require a compatible runtime upgrade.",
      409,
    );
  }
  const workflow = runtime.controlPlane.workflows.find(
    (candidate) => candidate.type === workflowType,
  ) as RuntimeWorkflowBinding | undefined;
  if (!workflow?.execute) {
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

  const started = await startPackWorkflowRun(env, identity, {
    workflowType,
    policyReference: `runtime:${pack.id}:${runtime.runtimeVersion}`,
    displayName: workflow.runDisplayName ?? workflow.label,
    packId: pack.id,
    toolInput: input,
    executionMode: "dry_run",
    engine: workflow.engine,
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
  const timeout = setTimeout(
    () => controller.abort(new Error("runtime_timeout")),
    pack.resourceLimits.maxRunSeconds * 1_000,
  );
  let calls = 0;

  const invokeTool = async (toolId: string, toolInput: Record<string, unknown>) => {
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
        callbackUrl: `${new URL(request.url).origin}/workbench/run-callbacks`,
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
    managedState: {
      async upsert(state) {
        const expectedVersion =
          state.expectedVersion ??
          (await readManagedStateVersion(env, identity, {
            namespace: state.namespace,
            stateType: state.stateType,
            stateKey: state.stateKey,
          }));
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

  let result: RuntimeResult;
  try {
    result = toolResult(await workflow.execute(input, context));
    if (result.ok)
      assertSchemaValue(workflow.outputSchema, result.output, `${workflowType} output`);
  } catch (error) {
    result = failure(error);
  } finally {
    clearTimeout(timeout);
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
  const finished = await finishPackWorkflowRun(env, identity, {
    ...started,
    workflowType,
    ok: result.ok,
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
        status: result.ok ? "completed" : "failed",
        engine: workflow.engine,
        workflowType,
        runtimeVersion: runtime.runtimeVersion,
      },
      ...(artifacts[0]
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
      ...(result.ok ? { report: result.output } : { error: result.error.message }),
    },
    { status: result.ok ? 201 : 502 },
  );
};
