import type { RuntimeContextPort } from "@operloom/agent-sdk";
import { estimateModelInputTokens } from "./runtime-models";
import {
  reserveRuntimeUsage,
  settleRuntimeUsage,
  type RuntimeUsageReservation,
} from "./runtime-usage";
import type { AgentIdentity, Env } from "./types";

export const chatRuntimeFailureCode = (error: unknown) => {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" &&
    [
      "context_blocked",
      "budget_not_configured",
      "resource_admission_denied",
      "usage_scope_denied",
      "usage_run_inactive",
      "model_outcome_unknown",
      "workspace_export_in_progress",
    ].includes(code)
    ? code
    : "runtime_failed";
};

/** One reservation per provider step, including follow-up calls after tool results. */
export const createChatUsageTracker = (
  env: Env,
  identity: AgentIdentity,
  input: {
    runId: string;
    packId: string;
    model: string;
    maxOutputTokens: number;
    system: string;
    tools?: unknown;
    context?: RuntimeContextPort;
    signal: AbortSignal;
  },
) => {
  const pending = new Map<number, RuntimeUsageReservation>();
  return {
    async beforeStep(stepNumber: number, messages: unknown) {
      input.signal.throwIfAborted();
      input.context?.assertReady();
      const payload = JSON.parse(
        JSON.stringify({
          model: input.model,
          system: input.system,
          messages,
          tools: input.tools ?? null,
        }),
      );
      const claim = await reserveRuntimeUsage(env, identity, {
        runId: input.runId,
        runKind: "chat",
        packId: input.packId,
        kind: "model",
        operationKey: `chat-step-${stepNumber}`,
        payload,
        estimatedInputTokens: estimateModelInputTokens(payload),
        maxOutputTokens: input.maxOutputTokens,
        contextSnapshotId: input.context?.snapshot.id,
      });
      if (!claim.fresh)
        throw Object.assign(
          new Error(
            "This chat model step has already been admitted; automatic provider replay is disabled.",
          ),
          { code: "model_outcome_unknown" },
        );
      pending.set(stepNumber, claim.reservation);
    },
    async afterStep(
      stepNumber: number,
      usage: { inputTokens?: number; outputTokens?: number },
      source: "provider" | "fixture" = "provider",
    ) {
      const reservation = pending.get(stepNumber);
      if (!reservation) return;
      pending.delete(stepNumber);
      await settleRuntimeUsage(env, reservation, {
        status: "settled",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        source,
      });
    },
    async fail() {
      const reservations = [...pending.values()];
      pending.clear();
      for (const reservation of reservations)
        await settleRuntimeUsage(env, reservation, {
          status: "unknown",
          errorCode: "chat_outcome_unknown",
        });
    },
  };
};
