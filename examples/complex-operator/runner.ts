import { defineRunnerModule, type RunnerRuntimeModule } from "@operloom/agent-sdk/runner";

import { operatorActionTool, operatorPageReadTool, operatorSnapshotTool } from "./control-plane.js";

const runnerDefinition: Omit<RunnerRuntimeModule, "apiVersion" | "kind"> = {
  packId: "complex-operator",
  runtimeVersion: "1.2.3",
  compatiblePackVersions: "^1.1.0",
  tools: [
    {
      ...operatorPageReadTool,
      async execute(input, context) {
        if (!context.recipes)
          return {
            ok: false,
            error: { code: "recipes_unavailable", message: "Runner recipes are unavailable." },
            summary: "The runner offered no recipes.",
          };
        const url = String(input.url);
        const page = await context.recipes.browser({
          url,
          allowHosts: context.networkPolicy?.allowedHosts ?? [],
          maxBytes: 16_384,
          extract: {
            headline: typeof input.headlineSelector === "string" ? input.headlineSelector : "h1",
          },
        });
        if (page.status !== "completed")
          return {
            ok: false,
            error: { code: `page_${page.status}`, message: `The page read ${page.status}.` },
            summary: `Page read ${page.status}.`,
          };
        await context.recipes.artifact.upload({
          kind: "page_excerpt",
          title: page.title ?? url,
          mimeType: "application/json",
          data: {
            url: page.finalUrl ?? url,
            title: page.title ?? "",
            text: page.text.slice(0, 2000),
          },
        });
        return {
          ok: true,
          output: {
            status: page.status,
            engine: page.engine,
            title: page.title ?? "",
            headline: page.fields.headline ?? "",
            blockedRequests: page.blockedRequests,
            usage: context.recipes.usage(),
          },
          summary: `Read "${page.title ?? url}" through the ${page.engine} engine.`,
        };
      },
    },
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
