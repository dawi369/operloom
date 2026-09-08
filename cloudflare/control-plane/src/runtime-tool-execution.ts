import {
  assertSchemaValue,
  type AgentExecutionContext,
  type RuntimeResult,
  type RuntimeToolBinding,
} from "@operloom/agent-sdk/control-plane";

import {
  invokeFlyToolRunner,
  noEgressSandboxContract,
  runnerMetadataFor,
  type ToolRunnerSandboxContract,
} from "./tool-runner";
import type { AgentIdentity, Env } from "./types";

export type RuntimeToolExecutionIdentity = {
  runId: string;
  workflowIntentId: string;
  toolCallId: string;
  packVersion: string;
  runtimeVersion: string;
  bindingVersion: number;
  policyDecisionId?: string;
  traceId?: string | null;
  callbackUrl?: string;
  source: "agent-pack" | "model" | "admin";
};

export const runtimeToolFailure = (error: unknown): RuntimeResult => ({
  ok: false,
  error: {
    code:
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "runtime_tool_failed",
    message: error instanceof Error ? error.message : "Runtime tool failed.",
    retryable: false,
    redacted: true,
  },
  summary: error instanceof Error ? error.message : "Runtime tool failed.",
});

const normalizeResult = (value: unknown): RuntimeResult => {
  if (value && typeof value === "object" && "ok" in value && typeof value.ok === "boolean") {
    const candidate = value as Record<string, unknown> & { ok: boolean };
    if (candidate.ok && candidate.output && typeof candidate.output === "object") {
      return {
        ...(candidate as unknown as Extract<RuntimeResult, { ok: true }>),
        summary:
          typeof candidate.summary === "string" && candidate.summary
            ? candidate.summary
            : "Runtime tool completed.",
      };
    }
    const error = candidate.error;
    if (
      !candidate.ok &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      "message" in error &&
      typeof error.message === "string"
    ) {
      return {
        ...(candidate as unknown as Extract<RuntimeResult, { ok: false }>),
        summary:
          typeof candidate.summary === "string" && candidate.summary
            ? candidate.summary
            : error.message,
      };
    }
  }
  return runtimeToolFailure(
    Object.assign(new Error("Runtime tool returned an invalid result."), {
      code: "runtime_result_invalid",
    }),
  );
};

export const executeRuntimeToolBinding = async (input: {
  env: Env;
  identity: AgentIdentity;
  binding: RuntimeToolBinding;
  toolInput: Record<string, unknown>;
  context: AgentExecutionContext;
  execution: RuntimeToolExecutionIdentity;
}): Promise<RuntimeResult> => {
  const { binding, execution } = input;
  try {
    assertSchemaValue(binding.inputSchema, input.toolInput, `${binding.id} input`);
    let result: RuntimeResult;
    if (binding.transport === "cloudflare_inline") {
      if (!binding.execute) {
        throw Object.assign(new Error(`Tool ${binding.id} has no inline binding.`), {
          code: "tool_binding_unavailable",
        });
      }
      result = normalizeResult(await binding.execute(input.toolInput, input.context));
    } else {
      const runner = runnerMetadataFor(
        {
          toolName: binding.id,
          adapterVersion: binding.adapterVersion,
          supportedExecutionModes: [...binding.executionModes],
          transport: "fly",
        },
        execution.source,
        "fly",
        (binding.sandbox as ToolRunnerSandboxContract | undefined) ??
          noEgressSandboxContract({
            template: binding.adapterVersion,
            maxRuntimeMs: binding.timeoutMs,
            maxArtifactBytes: binding.maxArtifactBytes,
          }),
      );
      result = normalizeResult(
        await invokeFlyToolRunner(
          input.env,
          input.identity,
          {
            scope: input.identity.scope,
            agentId: input.identity.agentId,
            runId: execution.runId,
            workflowIntentId: execution.workflowIntentId,
            toolCallId: execution.toolCallId,
            packVersion: execution.packVersion,
            runtimeVersion: execution.runtimeVersion,
            bindingVersion: execution.bindingVersion,
            toolName: binding.id,
            execution: { mode: "dry_run", policy: binding.policy.reference },
            input: input.toolInput,
            runner,
            callback: execution.callbackUrl
              ? {
                  url: execution.callbackUrl,
                  protocolVersion: "workflow-callback-v0",
                  traceId: execution.traceId,
                }
              : undefined,
            policyDecisionId: execution.policyDecisionId,
            source: execution.source,
            traceId: execution.traceId,
          },
          input.context.signal,
        ),
      );
    }
    if (result.ok) assertSchemaValue(binding.outputSchema, result.output, `${binding.id} output`);
    return result;
  } catch (error) {
    return runtimeToolFailure(error);
  }
};
