import { type AgentExecutionContext } from "@operloom/agent-sdk/control-plane";

import { json } from "./http";
import {
  finishPackWorkflowRun,
  recordPackWorkflowToolCall,
  type RuntimeRunIdentity,
} from "./runtime-run-lifecycle";
import type { ResolvedRuntimeTool } from "./runtime-tool-catalog";
import { executeRuntimeToolBinding, runtimeToolFailure } from "./runtime-tool-execution";
import type { AgentIdentity, Env } from "./types";
import { createBrokeredConnectionPort } from "./connection-broker";
import { createDurableActionPort } from "./action-authority";

export const executeResolvedRuntimeAdminTool = async (input: {
  requestUrl: string;
  env: Env;
  identity: AgentIdentity;
  resolved: ResolvedRuntimeTool;
  toolInput: Record<string, unknown>;
  policyDecisionId: string;
  started: RuntimeRunIdentity;
}) => {
  const { binding, packId, packVersion, runtimeVersion, connections } = input.resolved;
  const { started } = input;
  const toolCallId = `${started.runId}-tool-${binding.id.replaceAll(".", "-")}`;
  const context: AgentExecutionContext = {
    scope: { ...input.identity.scope, agentId: input.identity.agentId },
    pack: { id: packId, version: packVersion, runtimeVersion },
    run: {
      id: started.runId,
      workflowIntentId: started.workflowIntentId,
      executionMode: "dry_run",
      source: "user",
    },
    signal: new AbortController().signal,
    connections: createBrokeredConnectionPort(input.env, input.identity, connections),
    actions: createDurableActionPort(input.env, input.identity, {
      packId,
      packVersion,
      runtimeVersion,
      bindingVersion: 1,
      runId: started.runId,
      workflowIntentId: started.workflowIntentId,
      toolCallId,
    }),
    tools: {
      async invoke() {
        throw Object.assign(new Error("Nested Admin tools are disabled."), {
          code: "nested_tool_invocation_disabled",
        });
      },
    },
    managedState: {
      async upsert() {
        throw Object.assign(new Error("Admin tools cannot write managed state."), {
          code: "managed_state_write_disabled",
        });
      },
    },
    events: { async append() {} },
  };
  const result = await executeRuntimeToolBinding({
    env: input.env,
    identity: input.identity,
    binding,
    toolInput: input.toolInput,
    context,
    execution: {
      runId: started.runId,
      workflowIntentId: started.workflowIntentId,
      toolCallId,
      packVersion,
      runtimeVersion,
      bindingVersion: 1,
      policyDecisionId: input.policyDecisionId,
      callbackUrl:
        input.env.WORKBENCH_CALLBACK_URL ??
        `${new URL(input.requestUrl).origin}/workbench/run-callbacks`,
      source: "admin",
    },
  });
  const artifactBytes = (result.artifacts ?? []).reduce(
    (total, artifact) => total + JSON.stringify(artifact.data).length,
    0,
  );
  const bounded =
    artifactBytes <= binding.maxArtifactBytes
      ? result
      : runtimeToolFailure(
          Object.assign(new Error("Runtime artifact limit exceeded."), {
            code: "artifact_limit_exceeded",
          }),
        );
  await recordPackWorkflowToolCall(input.env, input.identity, {
    ...started,
    toolCallId,
    toolName: binding.id,
    status: bounded.ok ? "completed" : "failed",
    inputSummary: `Invoke ${binding.id}`,
    outputSummary: bounded.summary,
    data: {
      packId,
      packVersion,
      runtimeVersion,
      adapterVersion: binding.adapterVersion,
      transport: binding.transport,
      policyDecisionId: input.policyDecisionId,
      ...(bounded.ok ? { output: bounded.output } : { error: bounded.error }),
    },
  });
  const artifacts = (bounded.artifacts ?? []).map((artifact, index) => ({
    id:
      binding.transport === "fly"
        ? `${toolCallId}-artifact-${artifact.kind.replace(/[^a-z0-9_-]/gi, "-")}${index ? `-${index + 1}` : ""}`
        : `${started.runId}-artifact-${index + 1}`,
    kind: artifact.kind,
    uri: `d1://control-plane/${started.runId}/${artifact.kind}-${index + 1}.json`,
    title: artifact.title,
    mimeType: artifact.mimeType,
    sizeBytes: JSON.stringify(artifact.data).length,
    data: artifact.data,
    staged: binding.transport === "fly",
  }));
  const finished = await finishPackWorkflowRun(input.env, input.identity, {
    ...started,
    workflowType: `tool.${binding.id}`,
    ok: bounded.ok,
    summary: bounded.summary,
    artifacts,
    data: {
      packId,
      packVersion,
      runtimeVersion,
      bindingVersion: 1,
      adapterVersion: binding.adapterVersion,
      transport: binding.transport,
      policyDecisionId: input.policyDecisionId,
    },
  });
  if (!finished.applied) {
    return json(
      { ok: false, error: "Run is terminal", details: { code: "run_terminal" } },
      { status: 409 },
    );
  }
  return json(
    {
      ...bounded,
      run: {
        ...started,
        status: bounded.ok ? "completed" : "failed",
        runtimeVersion,
      },
      artifact: artifacts[0],
      policyDecisionId: input.policyDecisionId,
    },
    { status: bounded.ok ? 201 : 502 },
  );
};
