import {
  assertSchemaValue,
  defaultActionPort,
  defaultConnectionPort,
  type AgentExecutionContext,
  type RuntimeResult,
  type RuntimeToolBinding,
  type RuntimeWorkflowBinding,
} from "@operloom/agent-sdk";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { loadAgentModules } from "./agent-pack-compiler";
import { createAgentPackTestFetch } from "./agent-pack-test-fetch";

const readArg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

type ConformanceResult = { id: string; ok: boolean; summary: string };

const exampleValue = (schema: Record<string, unknown>): unknown => {
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  switch (schema.type) {
    case "string":
      return "conformance";
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "boolean":
      return false;
    case "array":
      return [];
    case "null":
      return null;
    case "object": {
      const properties =
        schema.properties && typeof schema.properties === "object"
          ? (schema.properties as Record<string, Record<string, unknown>>)
          : {};
      const required = Array.isArray(schema.required)
        ? schema.required.filter((name): name is string => typeof name === "string")
        : [];
      return Object.fromEntries(
        Object.entries(properties)
          .filter(([name, child]) => required.includes(name) || child.default !== undefined)
          .map(([name, child]) => [name, exampleValue(child)]),
      );
    }
    default:
      return {};
  }
};

export const runAgentPackConformance = async (root: string, requested: string) => {
  const modules = await loadAgentModules(root);
  const loaded = modules.find(
    (item) => item.manifest.id === requested || item.entry.package === requested,
  );
  if (!loaded) throw new Error(`Agent pack ${requested} is not configured.`);

  const results: ConformanceResult[] = [];
  for (const health of loaded.controlPlane.health) {
    const result = await health.check();
    results.push({ id: `health.${health.id}`, ...result });
  }
  for (const evaluation of loaded.controlPlane.evals) {
    const result = await evaluation.run();
    results.push({ id: `eval.${evaluation.id}`, ...result });
  }

  const exercisedTools = new Set<string>();
  const createContext = (workflowId: string) => {
    let stateVersion = 0;
    let toolCalls = 0;
    const controller = new AbortController();
    let context: AgentExecutionContext;
    const invoke = async (
      toolId: string,
      input: Record<string, unknown>,
    ): Promise<RuntimeResult> => {
      toolCalls += 1;
      exercisedTools.add(toolId);
      const controlPlaneTool = loaded.controlPlane.tools.find(
        (candidate) => candidate.id === toolId,
      );
      const runnerTool = loaded.runner.tools.find((candidate) => candidate.id === toolId);
      const tool = (
        controlPlaneTool?.execute ? controlPlaneTool : (runnerTool ?? controlPlaneTool)
      ) as RuntimeToolBinding | undefined;
      if (!tool?.execute) {
        return {
          ok: false,
          error: {
            code: "tool_binding_unavailable",
            message: `${toolId} is not executable.`,
            redacted: true,
          },
          summary: `${toolId} is not executable.`,
        };
      }
      assertSchemaValue(tool.inputSchema, input, `${toolId} input`);
      const result = await tool.execute(input, context);
      if (result.ok) assertSchemaValue(tool.outputSchema, result.output, `${toolId} output`);
      if (result.artifacts) {
        for (const artifact of result.artifacts) {
          if (!artifact.kind || !artifact.mimeType || !artifact.title) {
            throw new Error(`${toolId} returned an invalid artifact descriptor.`);
          }
        }
      }
      return result;
    };
    context = {
      scope: { userId: "conformance-user", workspaceId: "tenant-a", agentId: "agent-a" },
      pack: {
        id: loaded.manifest.id,
        version: loaded.manifest.version,
        runtimeVersion: loaded.controlPlane.runtimeVersion,
      },
      run: {
        id: `conformance-run-${workflowId}`,
        workflowIntentId: `conformance-intent-${workflowId}`,
        executionMode: "dry_run",
        source: "user",
      },
      signal: controller.signal,
      connections: defaultConnectionPort(loaded.manifest.connections),
      actions: defaultActionPort,
      tools: { invoke },
      managedState: {
        async upsert(input) {
          if ((input.expectedVersion ?? 0) !== stateVersion) {
            throw Object.assign(new Error("Managed-state compare-and-set conflict."), {
              code: "managed_state_version_conflict",
            });
          }
          stateVersion += 1;
          return { id: "conformance-state", version: stateVersion };
        },
      },
      events: { async append() {} },
    };
    return {
      context,
      controller,
      toolCalls: () => toolCalls,
    };
  };

  const workflows = loaded.controlPlane.workflows.filter(
    (
      candidate,
    ): candidate is RuntimeWorkflowBinding & {
      execute: NonNullable<RuntimeWorkflowBinding["execute"]>;
    } => typeof candidate.execute === "function",
  );
  for (const workflow of workflows) {
    const { context, controller, toolCalls } = createContext(workflow.type);
    const defaults = exampleValue(workflow.inputSchema) as Record<string, unknown>;
    const conformanceInput = { ...defaults, ...workflow.conformanceInput };
    const input = workflow.normalizeInput
      ? workflow.normalizeInput(conformanceInput)
      : conformanceInput;
    assertSchemaValue(workflow.inputSchema, input, `${workflow.type} input`);
    const output = await workflow.execute(input, context);
    controller.abort("workflow_complete");
    if (!output.ok) throw new Error(output.error.message);
    assertSchemaValue(workflow.outputSchema, output.output, `${workflow.type} output`);
    const artifacts = output.artifacts ?? [];
    const artifactBytes = artifacts.reduce(
      (total, artifact) => total + Buffer.byteLength(JSON.stringify(artifact)),
      0,
    );
    if (
      artifacts.some((artifact) => !artifact.kind || !artifact.title || !artifact.mimeType) ||
      artifactBytes > loaded.manifest.resourceLimits.maxArtifactBytes
    ) {
      throw new Error(`${workflow.type} returned artifacts outside its declared limits.`);
    }
    if (toolCalls() > loaded.manifest.resourceLimits.maxToolCallsPerRun) {
      throw new Error(`${workflow.type} exceeded its declared tool-call limit.`);
    }
    results.push({
      id: `workflow.${workflow.type}`,
      ok: true,
      summary: output.summary,
    });
  }

  for (const declared of loaded.controlPlane.tools) {
    assertSchemaValue(
      declared.inputSchema,
      exampleValue(declared.inputSchema),
      `${declared.id} generated conformance input`,
    );
    if (!exercisedTools.has(declared.id)) {
      const { context, controller } = createContext(`tool-${declared.id}`);
      const runner = loaded.runner.tools.find((candidate) => candidate.id === declared.id);
      const executable = declared.execute ? declared : runner;
      if (!executable?.execute) throw new Error(`${declared.id} has no executable provider.`);
      const input = exampleValue(declared.inputSchema) as Record<string, unknown>;
      const output = await executable.execute(input, context);
      controller.abort("tool_complete");
      if (output.ok) {
        assertSchemaValue(declared.outputSchema, output.output, `${declared.id} output`);
      } else if (!output.error.code || !output.error.message) {
        throw new Error(`${declared.id} returned an invalid structured error.`);
      }
      results.push({
        id: `tool.${declared.id}`,
        ok: true,
        summary: output.summary,
      });
    }
  }

  for (const renderer of loaded.manifest.artifactRenderers) {
    const contribution = loaded.web.artifactRenderers[renderer.artifactKind];
    if (!contribution) throw new Error(`${renderer.artifactKind} renderer is unavailable.`);
    if (typeof contribution === "function") {
      const rendered = contribution({
        artifact: {
          id: "conformance-artifact",
          kind: renderer.artifactKind,
          title: renderer.title,
          mimeType: "application/json",
          data: { status: "conformance" },
        },
      });
      if (rendered == null) throw new Error(`${renderer.artifactKind} renderer returned nothing.`);
    } else if (typeof contribution !== "object") {
      throw new Error(`${renderer.artifactKind} renderer descriptor is invalid.`);
    }
    results.push({
      id: `renderer.${renderer.artifactKind}`,
      ok: true,
      summary: `${renderer.renderer} renderer resolved.`,
    });
  }
  for (const descriptor of loaded.manifest.managedState) {
    for (const recordKind of descriptor.recordKinds) {
      const rendererId = `${descriptor.namespace}.${recordKind}`;
      const contribution = loaded.web.managedStateRenderers[rendererId];
      if (
        !contribution ||
        (typeof contribution !== "object" && typeof contribution !== "function")
      ) {
        throw new Error(`${rendererId} managed-state renderer descriptor is invalid.`);
      }
      results.push({
        id: `managed-state-renderer.${rendererId}`,
        ok: true,
        summary: "Managed-state renderer resolved.",
      });
    }
  }

  for (const connection of loaded.manifest.connections.filter(
    (candidate) => candidate.credentialClass !== "none",
  )) {
    const capability = await defaultConnectionPort(loaded.manifest.connections).resolve(
      connection.id,
      connection.toolIds[0] ?? "",
    );
    if (capability.status !== "authorization_required") {
      throw new Error(`${connection.id} must default to authorization_required.`);
    }
    results.push({
      id: `connection.${connection.id}`,
      ok: true,
      summary: capability.reason,
    });
  }
  await defaultActionPort.execute("not-authorized").then(
    () => {
      throw new Error("Action execution unexpectedly succeeded.");
    },
    (error: unknown) => {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "mutation_disabled"
      ) {
        throw error;
      }
    },
  );
  results.push({
    id: "action.mutation-disabled",
    ok: true,
    summary: "External mutation remains disabled.",
  });

  const failed = results.filter((result) => !result.ok);
  const report = {
    ok: failed.length === 0,
    packId: loaded.manifest.id,
    packVersion: loaded.manifest.version,
    runtimeVersion: loaded.controlPlane.runtimeVersion,
    workflowCount: workflows.length,
    results,
  };
  if (failed.length) throw new Error(`${failed.length} conformance checks failed.`);
  return report;
};

const main = async () => {
  const requested = readArg("--pack");
  if (!requested) throw new Error("Usage: pnpm agent-packs:test --pack <pack-id>");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createAgentPackTestFetch();
  try {
    console.log(JSON.stringify(await runAgentPackConformance(process.cwd(), requested), null, 2));
  } finally {
    globalThis.fetch = originalFetch;
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
