import {
  requireDurableAttemptAuthority,
  type DurableAttemptAuthority,
} from "./durable-attempt-authority";
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
import { effectTargetOf, type AgentIdentity, type Env } from "./types";
import { resolvePackRuntime } from "../../../lib/agent-runtime/registry";
import { bindRuntimeContext, captureRuntimeContext, contextIsRequired } from "./runtime-context";
import {
  reserveRuntimeUsage,
  settleRuntimeUsage,
  type RuntimeUsageReservation,
} from "./runtime-usage";

export type RuntimeToolExecutionIdentity = {
  runId: string;
  workflowIntentId: string;
  toolCallId: string;
  packVersion: string;
  runtimeVersion: string;
  bindingVersion: number;
  policyDecisionId?: string;
  durableAttempt?: DurableAttemptAuthority;
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
  let reservation: RuntimeUsageReservation | undefined;
  try {
    assertSchemaValue(binding.inputSchema, input.toolInput, `${binding.id} input`);
    if (
      !input.context.context &&
      contextIsRequired(resolvePackRuntime(input.context.pack.id, input.context.pack.version))
    ) {
      const evidence = await captureRuntimeContext(input.env, input.identity, {
        runId: execution.runId,
        durableAttempt: execution.durableAttempt,
        runKind: "workflow",
        input: input.toolInput,
        target: effectTargetOf(input.identity),
        signal: AbortSignal.any([input.context.signal, AbortSignal.timeout(binding.timeoutMs)]),
      });
      if (!evidence)
        throw Object.assign(new Error("Required tool context is unavailable."), {
          code: "context_blocked",
        });
      bindRuntimeContext(input.context, evidence);
    }
    input.context.context?.assertReady();
    const claim = await reserveRuntimeUsage(input.env, input.identity, {
      runId: execution.runId,
      durableAttempt: execution.durableAttempt,
      runKind: "workflow",
      packId: input.context.pack.id,
      kind: "tool",
      operationKey: execution.toolCallId,
      payload: {
        toolId: binding.id,
        input: input.toolInput,
        adapterVersion: binding.adapterVersion,
      },
      contextSnapshotId: input.context.context?.snapshot.id,
      maxRuntimeMs: binding.timeoutMs,
    });
    if (!claim.fresh)
      throw Object.assign(
        new Error(
          "This tool operation has already been admitted; inspect its outcome before retrying.",
        ),
        { code: "tool_already_dispatched" },
      );
    reservation = claim.reservation;
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
    if (reservation) {
      await settleRuntimeUsage(input.env, reservation, {
        status: result.ok ? "settled" : "unknown",
        ...(result.ok ? {} : { errorCode: result.error.code }),
      });
      reservation = undefined;
    }
    if (execution.durableAttempt)
      await requireDurableAttemptAuthority(
        input.env,
        input.identity,
        execution.runId,
        execution.durableAttempt,
      );
    return result;
  } catch (error) {
    if (reservation) {
      try {
        await settleRuntimeUsage(input.env, reservation, {
          status: "unknown",
          errorCode: "tool_outcome_unknown",
        });
      } catch {
        return runtimeToolFailure(
          Object.assign(
            new Error(
              "Tool outcome could not be recorded. Reserved usage is retained; do not automatically redispatch.",
            ),
            { code: "tool_outcome_unknown" },
          ),
        );
      }
    }
    return runtimeToolFailure(error);
  }
};
