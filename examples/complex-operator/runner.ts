import { defineRunnerModule, type RunnerRuntimeModule } from "@operloom/agent-sdk/runner";

import { operatorActionTool, operatorSnapshotTool } from "./control-plane.js";

const runnerDefinition: Omit<RunnerRuntimeModule, "apiVersion" | "kind"> = {
  packId: "complex-operator",
  runtimeVersion: "1.2.3",
  compatiblePackVersions: "^1.1.0",
  tools: [
    {
      ...operatorSnapshotTool,
      execute(input) {
        return {
          ok: true,
          output: {
            subject: String(input.subject),
            observedAt: "2026-01-01T00:00:00.000Z",
            status: "nominal",
          },
          summary: "Deterministic signed-runner snapshot completed.",
        };
      },
    },
    {
      ...operatorActionTool,
      async execute(input, context) {
        const idempotencyKey = String(input.idempotencyKey ?? "missing-idempotency-key");
        const preview =
          input.preview && typeof input.preview === "object"
            ? (input.preview as Record<string, unknown>)
            : {};
        const connection = await context.connections.resolve(
          "operator.external-account",
          "operator.action.execute",
        );
        if (connection.status !== "authorized" || !connection.request) {
          return {
            ok: false,
            error: {
              code: "connection_not_authorized",
              message: connection.reason,
              redacted: true,
            },
            summary: "The synthetic action connection is unavailable.",
          };
        }
        const delayMs =
          typeof preview.delayMs === "number"
            ? Math.max(0, Math.min(10_000, Math.trunc(preview.delayMs)))
            : 0;
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const providerResponse = await connection.request({
          url: "broker://configured",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            idempotencyKey,
            outcome: preview.outcome,
          }),
        });
        const providerBody = JSON.parse(providerResponse.body) as {
          externalReference?: string;
        };
        const status = preview.outcome === "unknown" ? "outcome_unknown" : "executed";
        const externalReference = providerBody.externalReference ?? `synthetic:${idempotencyKey}`;
        return {
          ok: true,
          output: {
            status,
            summary:
              status === "executed"
                ? "Synthetic external action executed idempotently."
                : "Synthetic provider accepted the request but withheld its outcome.",
            idempotencyKey,
            externalReference,
            transport: "fly",
          },
          summary:
            status === "executed"
              ? "Synthetic external action executed idempotently."
              : "Synthetic provider accepted the request but withheld its outcome.",
        };
      },
    },
  ],
};

export const runner = defineRunnerModule(runnerDefinition);
