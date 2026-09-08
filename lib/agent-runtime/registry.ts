import type {
  ControlPlaneRuntimeModule,
  LocalAgentPackManifest,
  RuntimeRecord,
  RuntimeWorkflowBinding,
  WorkflowFormField,
} from "@operloom/agent-sdk";
import {
  assertSchemaValue,
  isPackVersionCompatible,
  isWorkbenchVersionCompatible,
} from "@operloom/agent-sdk";

import { agentControlPlaneRegistry } from "../../generated/agent-runtime/control-plane";
import { agentManifestRegistry } from "../../generated/agent-runtime/manifests";
import { compiledWorkbenchVersion } from "../../generated/agent-runtime/platform";

export type PackWorkflowRequest = {
  executionMode: "dry_run";
  input: Record<string, string | number | boolean>;
};

export type PackWorkflowFieldDefinition = WorkflowFormField;
export type PackWorkflowFieldName = string;

export type PackWorkflowBinding = RuntimeWorkflowBinding & {
  workflowType: string;
  requiredPackId: string;
  runtimeVersion: string;
  compatiblePackVersions: string;
  workerRoute: string;
  route: string;
  artifactKind: string;
  smokeCommand: string;
  defaultInput: Record<string, string | number | boolean>;
  fields: string[];
  buildRequest: (input: RuntimeRecord) => PackWorkflowRequest;
};

const defaultInputFor = (workflow: RuntimeWorkflowBinding) => {
  const properties =
    workflow.inputSchema.properties && typeof workflow.inputSchema.properties === "object"
      ? (workflow.inputSchema.properties as Record<string, Record<string, unknown>>)
      : {};
  return Object.fromEntries(
    Object.entries(properties)
      .filter(([, schema]) => schema.default !== undefined)
      .map(([name, schema]) => [name, schema.default]),
  ) as Record<string, string | number | boolean>;
};

const registryEntries = Object.values(agentControlPlaneRegistry).flatMap((entry) => {
  const manifestEntry =
    agentManifestRegistry[entry.module.packId as keyof typeof agentManifestRegistry];
  return entry.module.workflows.map((compiledWorkflow) => {
    const workflow: RuntimeWorkflowBinding = compiledWorkflow;
    const defaults = defaultInputFor(workflow);
    const buildRequest = (input: RuntimeRecord): PackWorkflowRequest => {
      const normalized = workflow.normalizeInput
        ? workflow.normalizeInput({ ...defaults, ...input })
        : { ...defaults, ...input };
      assertSchemaValue(workflow.inputSchema, normalized, `${workflow.type} input`);
      return {
        executionMode: "dry_run",
        input: normalized as Record<string, string | number | boolean>,
      };
    };
    return [
      workflow.type,
      {
        ...workflow,
        workflowType: workflow.type,
        requiredPackId: entry.module.packId,
        runtimeVersion: entry.module.runtimeVersion,
        compatiblePackVersions: entry.module.compatiblePackVersions,
        workerRoute: `/workbench/workflows/${encodeURIComponent(workflow.type)}`,
        route: `/api/workbench/workflows/${encodeURIComponent(workflow.type)}`,
        artifactKind: manifestEntry.module.artifactRenderers[0]?.artifactKind ?? "json_artifact",
        smokeCommand: workflow.smokeCommand ?? "pnpm conformance:agent-system",
        defaultInput: (workflow.normalizeInput
          ? workflow.normalizeInput(defaults)
          : defaults) as Record<string, string | number | boolean>,
        fields: workflow.form.map((field) => field.name),
        buildRequest,
      } satisfies PackWorkflowBinding,
    ] as const;
  });
});

export const packWorkflowBindings = Object.fromEntries(registryEntries) as Record<
  string,
  PackWorkflowBinding
>;

export type PackWorkflowType = keyof typeof packWorkflowBindings;

export const buildPackWorkflowRequest = (
  workflowType: string,
  input: RuntimeRecord = {},
): PackWorkflowRequest | null => {
  const binding = packWorkflowBindings[workflowType];
  return binding ? binding.buildRequest(input) : null;
};

export const fieldDefinitionsForPackWorkflow = (
  binding: Pick<PackWorkflowBinding, "form">,
): PackWorkflowFieldDefinition[] => [...binding.form];

export const packWorkflowFieldDefinitions = Object.fromEntries(
  Object.values(packWorkflowBindings).flatMap((binding) =>
    binding.form.map((field) => [field.name, field]),
  ),
) as Record<string, PackWorkflowFieldDefinition>;

export const resolveRuntimeCompatibility = (input: {
  workbenchVersion: string;
  packVersion: string;
  manifest: Pick<LocalAgentPackManifest, "compatibility">;
  controlPlane: ControlPlaneRuntimeModule;
}) => {
  if (
    !isWorkbenchVersionCompatible(
      input.workbenchVersion,
      input.manifest.compatibility.minimumWorkbenchVersion,
      input.manifest.compatibility.maximumWorkbenchVersion,
    )
  ) {
    return {
      runnable: false as const,
      reason: "workbench_incompatible" as const,
      runtimeVersion: input.controlPlane.runtimeVersion,
    };
  }
  if (!isPackVersionCompatible(input.packVersion, input.controlPlane.compatiblePackVersions)) {
    return {
      runnable: false as const,
      reason: "runtime_incompatible" as const,
      runtimeVersion: input.controlPlane.runtimeVersion,
    };
  }
  return {
    runnable: true as const,
    runtimeVersion: input.controlPlane.runtimeVersion,
    controlPlane: input.controlPlane,
  };
};

export const resolvePackRuntime = (packId: string, packVersion: string) => {
  const controlPlane = agentControlPlaneRegistry[packId as keyof typeof agentControlPlaneRegistry];
  const manifest = agentManifestRegistry[packId as keyof typeof agentManifestRegistry];
  if (!controlPlane || !manifest) {
    return { runnable: false as const, reason: "runtime_missing" as const };
  }
  return resolveRuntimeCompatibility({
    workbenchVersion: compiledWorkbenchVersion,
    packVersion,
    manifest: manifest.module,
    controlPlane: controlPlane.module,
  });
};

export const resolveRuntimeTool = (toolId: string) => {
  for (const entry of Object.values(agentControlPlaneRegistry)) {
    const tool = entry.module.tools.find((candidate) => candidate.id === toolId);
    if (tool)
      return { packId: entry.module.packId, runtimeVersion: entry.module.runtimeVersion, tool };
  }
  return null;
};
