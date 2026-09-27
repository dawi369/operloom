import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  localAgentPacks,
  packWorkflowBindings,
  validateLocalAgentPack,
  validateLocalAgentPacks,
  type LocalAgentPackManifest,
} from "../../agent-packs";
import {
  agentBehaviorTemplates,
  createAgentBehaviorSnapshot,
  type AgentBehaviorTemplate,
} from "../../cloudflare/control-plane/src/agent-behavior-templates";
import { toolPolicyCatalog } from "../../cloudflare/control-plane/src/tool-policy";

export type AgentPackIssueSeverity = "error" | "warning";

export type AgentPackIssue = {
  severity: AgentPackIssueSeverity;
  packId?: string;
  field?: string;
  message: string;
};

export type AgentPackRuntimeToolBinding = {
  id: string;
  invocation: "user" | "agent" | "workflow";
  registered: boolean;
  policyReference?: string;
  modelVisibleDefault: boolean;
  catalogModelVisible?: boolean;
  allowedExecutionModes?: string[];
};

export type AgentPackRuntimeWorkflowBinding = {
  type: string;
  registered: boolean;
  workerRoute?: string;
  vercelRoute?: string;
  smokeCommand?: string;
};

export type AgentPackValidationResult = {
  ok: boolean;
  packCount: number;
  errors: AgentPackIssue[];
  warnings: AgentPackIssue[];
};

export type AgentPackInspection = {
  ok: true;
  pack: {
    apiVersion: number;
    id: string;
    templateId: string;
    name: string;
    description: string;
    capabilityLevel: string;
    profile: string;
    version: string;
    folderPath: string;
    codePath: string;
    promptPath: string;
    ui: LocalAgentPackManifest["ui"];
    risk: LocalAgentPackManifest["risk"];
    connections: LocalAgentPackManifest["connections"];
    context: LocalAgentPackManifest["context"];
    managedState: LocalAgentPackManifest["managedState"];
    triggers: LocalAgentPackManifest["triggers"];
    artifactRenderers: LocalAgentPackManifest["artifactRenderers"];
    healthChecks: LocalAgentPackManifest["healthChecks"];
    evals: LocalAgentPackManifest["evals"];
    compatibility: LocalAgentPackManifest["compatibility"];
    resourceLimits: LocalAgentPackManifest["resourceLimits"];
    smokeScenarios: readonly { id: string; prompt: string }[];
  };
  tools: AgentPackRuntimeToolBinding[];
  workflows: AgentPackRuntimeWorkflowBinding[];
  validation: AgentPackValidationResult;
};

export type AgentPackSmokeResult =
  | {
      ok: true;
      packId: string;
      templateId: string;
      templateMapped: true;
      snapshotMapped: true;
      nextCommands: string[];
      warnings: AgentPackIssue[];
    }
  | {
      ok: false;
      packId: string;
      errors: AgentPackIssue[];
      warnings: AgentPackIssue[];
    };

export const knownAgentPackWorkflowBindings: Record<
  string,
  Omit<AgentPackRuntimeWorkflowBinding, "type" | "registered">
> = Object.fromEntries(
  Object.values(packWorkflowBindings).map((binding) => [
    binding.workflowType,
    {
      workerRoute: binding.workerRoute,
      vercelRoute: binding.route,
      smokeCommand: binding.smokeCommand,
    },
  ]),
);

const toolIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
const workflowTypePattern = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$/;
const secretAssignmentPattern =
  /\b(?:api[_-]?key|token|secret|password|private[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}/i;

const issue = (
  severity: AgentPackIssueSeverity,
  message: string,
  input?: { packId?: string; field?: string },
): AgentPackIssue => ({
  severity,
  message,
  ...(input?.packId ? { packId: input.packId } : {}),
  ...(input?.field ? { field: input.field } : {}),
});

const pathFor = (rootDir: string, filePath: string) => path.join(rootDir, filePath);

const readPromptFile = (rootDir: string, promptPath: string) => {
  const absolutePath = pathFor(rootDir, promptPath);
  if (!existsSync(absolutePath)) return null;
  return readFileSync(absolutePath, "utf8").trim();
};

const validatePackProvenance = (
  pack: LocalAgentPackManifest,
  input: { rootDir: string; errors: AgentPackIssue[] },
) => {
  const expectedFolderPath = `agent-packs/${pack.id}`;
  const expectedCodePath = `${expectedFolderPath}/index.ts`;
  const expectedPromptPath = `${expectedFolderPath}/prompt.xml`;

  if (pack.folderPath !== expectedFolderPath) {
    input.errors.push(
      issue("error", `folderPath must be ${expectedFolderPath}.`, {
        packId: pack.id,
        field: "folderPath",
      }),
    );
  }
  if (pack.codePath !== expectedCodePath) {
    input.errors.push(
      issue("error", `codePath must be ${expectedCodePath}.`, {
        packId: pack.id,
        field: "codePath",
      }),
    );
  }
  if (pack.promptPath !== expectedPromptPath) {
    input.errors.push(
      issue("error", `promptPath must be ${expectedPromptPath}.`, {
        packId: pack.id,
        field: "promptPath",
      }),
    );
  }

  if (!existsSync(pathFor(input.rootDir, pack.folderPath))) {
    input.errors.push(
      issue("error", `folderPath does not exist: ${pack.folderPath}.`, {
        packId: pack.id,
        field: "folderPath",
      }),
    );
  }
  if (!existsSync(pathFor(input.rootDir, pack.codePath))) {
    input.errors.push(
      issue("error", `codePath does not exist: ${pack.codePath}.`, {
        packId: pack.id,
        field: "codePath",
      }),
    );
  }
  const promptFile = readPromptFile(input.rootDir, pack.promptPath);
  if (promptFile === null) {
    input.errors.push(
      issue("error", `promptPath does not exist: ${pack.promptPath}.`, {
        packId: pack.id,
        field: "promptPath",
      }),
    );
  } else if (promptFile !== pack.prompt.trim()) {
    input.errors.push(
      issue("error", "prompt.xml must match the manifest prompt exactly.", {
        packId: pack.id,
        field: "prompt",
      }),
    );
  }
};

const validatePackContent = (
  pack: LocalAgentPackManifest,
  input: { errors: AgentPackIssue[]; warnings: AgentPackIssue[] },
) => {
  try {
    validateLocalAgentPack(pack);
  } catch (error) {
    input.errors.push(
      issue("error", error instanceof Error ? error.message : String(error), { packId: pack.id }),
    );
  }

  if (!pack.context.length) {
    input.errors.push(
      issue("error", "context must include at least one hint.", {
        packId: pack.id,
        field: "context",
      }),
    );
  }

  if (!pack.smokeScenarios.length) {
    input.errors.push(
      issue("error", "smokeScenarios must include at least one scenario.", {
        packId: pack.id,
        field: "smokeScenarios",
      }),
    );
  }
  const smokeScenarioIds = new Set<string>();
  for (const scenario of pack.smokeScenarios) {
    if (!scenario.id.trim() || !scenario.prompt.trim()) {
      input.errors.push(
        issue("error", "smoke scenario id and prompt are required.", {
          packId: pack.id,
          field: "smokeScenarios",
        }),
      );
    }
    if (smokeScenarioIds.has(scenario.id)) {
      input.errors.push(
        issue("error", `smoke scenario ${scenario.id} is duplicate.`, {
          packId: pack.id,
          field: "smokeScenarios",
        }),
      );
    }
    smokeScenarioIds.add(scenario.id);
  }

  if (secretAssignmentPattern.test(pack.prompt)) {
    input.errors.push(
      issue("error", "prompt appears to contain an inline secret assignment.", {
        packId: pack.id,
        field: "prompt",
      }),
    );
  }

  for (const tool of pack.tools) {
    if (!toolIdPattern.test(tool.id)) {
      input.errors.push(
        issue("error", `tool id ${tool.id} is malformed.`, {
          packId: pack.id,
          field: "tools",
        }),
      );
    }
    if (tool.executionModes.includes("execute") && !pack.risk.externalMutation) {
      input.errors.push(
        issue("error", `tool ${tool.id} cannot declare execute without externalMutation risk.`, {
          packId: pack.id,
          field: "tools",
        }),
      );
    }
    if (tool.executionModes.includes("execute") && pack.risk.productionGate === "none") {
      input.errors.push(
        issue("error", `tool ${tool.id} cannot declare execute without a production gate.`, {
          packId: pack.id,
          field: "tools",
        }),
      );
    }
    if (!toolPolicyCatalog[tool.id]) {
      input.warnings.push(
        issue("warning", `tool ${tool.id} is not registered in the runtime tool catalog.`, {
          packId: pack.id,
          field: "tools",
        }),
      );
    }
  }

  const workflowTypes = new Set<string>();
  for (const workflow of pack.workflows) {
    if (!workflowTypePattern.test(workflow.type)) {
      input.errors.push(
        issue("error", `workflow type ${workflow.type} is malformed.`, {
          packId: pack.id,
          field: "workflows",
        }),
      );
    }
    if (workflowTypes.has(workflow.type)) {
      input.errors.push(
        issue("error", `workflow ${workflow.type} is duplicate.`, {
          packId: pack.id,
          field: "workflows",
        }),
      );
    }
    workflowTypes.add(workflow.type);
    if (!knownAgentPackWorkflowBindings[workflow.type]) {
      input.warnings.push(
        issue("warning", `workflow ${workflow.type} has no known runtime route binding.`, {
          packId: pack.id,
          field: "workflows",
        }),
      );
    }
  }
};

export const validateAgentPacksForDeveloperLoop = (input?: {
  packs?: readonly LocalAgentPackManifest[];
  rootDir?: string;
}): AgentPackValidationResult => {
  const rootDir = input?.rootDir ?? process.cwd();
  const packs = input?.packs ?? localAgentPacks;
  const errors: AgentPackIssue[] = [];
  const warnings: AgentPackIssue[] = [];

  try {
    validateLocalAgentPacks(packs);
  } catch (error) {
    errors.push(issue("error", error instanceof Error ? error.message : String(error)));
  }

  const packIds = new Set<string>();
  const templateIds = new Set<string>();
  for (const pack of packs) {
    if (packIds.has(pack.id)) {
      errors.push(issue("error", `Agent pack id ${pack.id} is duplicate.`, { packId: pack.id }));
    }
    if (templateIds.has(pack.templateId)) {
      errors.push(
        issue("error", `Agent pack templateId ${pack.templateId} is duplicate.`, {
          packId: pack.id,
        }),
      );
    }
    packIds.add(pack.id);
    templateIds.add(pack.templateId);

    validatePackProvenance(pack, { rootDir, errors });
    validatePackContent(pack, { errors, warnings });
  }

  return {
    ok: errors.length === 0,
    packCount: packs.length,
    errors,
    warnings,
  };
};

export const inspectAgentPackForDeveloperLoop = (
  packId: string,
  input?: { packs?: readonly LocalAgentPackManifest[]; rootDir?: string },
): AgentPackInspection | { ok: false; errors: AgentPackIssue[]; warnings: AgentPackIssue[] } => {
  const packs = input?.packs ?? localAgentPacks;
  const pack = packs.find((candidate) => candidate.id === packId);
  const validation = validateAgentPacksForDeveloperLoop({
    packs,
    rootDir: input?.rootDir,
  });
  if (!pack) {
    return {
      ok: false,
      errors: [issue("error", `Agent pack ${packId} was not found.`)],
      warnings: validation.warnings,
    };
  }

  return {
    ok: true,
    pack: {
      apiVersion: pack.apiVersion,
      id: pack.id,
      templateId: pack.templateId,
      name: pack.name,
      description: pack.description,
      capabilityLevel: pack.capabilityLevel,
      profile: pack.profile,
      version: pack.version,
      folderPath: pack.folderPath,
      codePath: pack.codePath,
      promptPath: pack.promptPath,
      ui: pack.ui,
      risk: pack.risk,
      connections: pack.connections,
      context: pack.context,
      managedState: pack.managedState,
      triggers: pack.triggers,
      artifactRenderers: pack.artifactRenderers,
      healthChecks: pack.healthChecks,
      evals: pack.evals,
      compatibility: pack.compatibility,
      resourceLimits: pack.resourceLimits,
      smokeScenarios: pack.smokeScenarios,
    },
    tools: pack.tools.map((tool) => {
      const catalogEntry = toolPolicyCatalog[tool.id];
      return {
        id: tool.id,
        invocation: tool.invocation,
        registered: Boolean(catalogEntry),
        policyReference: catalogEntry?.policyReference,
        modelVisibleDefault: tool.modelVisibleDefault,
        catalogModelVisible: catalogEntry?.modelVisible,
        allowedExecutionModes: catalogEntry?.allowedExecutionModes,
      };
    }),
    workflows: pack.workflows.map((workflow) => {
      const binding = knownAgentPackWorkflowBindings[workflow.type];
      return {
        type: workflow.type,
        registered: Boolean(binding),
        ...binding,
      };
    }),
    validation,
  };
};

export const smokeAgentPackForDeveloperLoop = (
  packId: string,
  input?: { packs?: readonly LocalAgentPackManifest[]; rootDir?: string },
): AgentPackSmokeResult => {
  const packs = input?.packs ?? localAgentPacks;
  const validation = validateAgentPacksForDeveloperLoop({ packs, rootDir: input?.rootDir });
  const pack = packs.find((candidate) => candidate.id === packId);
  if (!pack) {
    return {
      ok: false,
      packId,
      errors: [issue("error", `Agent pack ${packId} was not found.`)],
      warnings: validation.warnings,
    };
  }

  const packErrors = validation.errors.filter((item) => !item.packId || item.packId === pack.id);
  if (packErrors.length) {
    return { ok: false, packId, errors: packErrors, warnings: validation.warnings };
  }

  const template = (agentBehaviorTemplates as AgentBehaviorTemplate[]).find(
    (item) => item.id === pack.templateId,
  );
  const errors: AgentPackIssue[] = [];
  if (!template) {
    errors.push(
      issue("error", `Behavior template ${pack.templateId} was not registered.`, {
        packId: pack.id,
        field: "templateId",
      }),
    );
  } else {
    if (template.pack?.id !== pack.id) {
      errors.push(
        issue("error", `Behavior template ${pack.templateId} does not point at ${pack.id}.`, {
          packId: pack.id,
          field: "templateId",
        }),
      );
    }
    if (template.prompt.trim() !== pack.prompt.trim()) {
      errors.push(
        issue("error", `Behavior template ${pack.templateId} prompt does not match pack prompt.`, {
          packId: pack.id,
          field: "prompt",
        }),
      );
    }
  }

  const snapshot = createAgentBehaviorSnapshot(pack.profile, pack.templateId);
  if (
    snapshot.templateId !== pack.templateId ||
    snapshot.authoring?.kind !== "local_agent_pack" ||
    snapshot.authoring.packId !== pack.id
  ) {
    errors.push(
      issue("error", `Behavior snapshot did not preserve pack identity for ${pack.id}.`, {
        packId: pack.id,
        field: "templateId",
      }),
    );
  }
  if (snapshot.prompt.trim() !== pack.prompt.trim()) {
    errors.push(
      issue("error", `Behavior snapshot prompt does not match pack prompt for ${pack.id}.`, {
        packId: pack.id,
        field: "prompt",
      }),
    );
  }

  if (errors.length) return { ok: false, packId, errors, warnings: validation.warnings };

  const nextCommands = Array.from(
    new Set(
      pack.workflows
        .map((workflow) => knownAgentPackWorkflowBindings[workflow.type]?.smokeCommand)
        .filter((command): command is string => Boolean(command)),
    ),
  );

  return {
    ok: true,
    packId: pack.id,
    templateId: pack.templateId,
    templateMapped: true,
    snapshotMapped: true,
    nextCommands,
    warnings: validation.warnings.filter((item) => !item.packId || item.packId === pack.id),
  };
};

export const formatAgentPackIssues = (issues: AgentPackIssue[]) =>
  issues
    .map((item) => {
      const scope = [item.packId, item.field].filter(Boolean).join(" ");
      return `- ${item.severity.toUpperCase()}${scope ? ` [${scope}]` : ""}: ${item.message}`;
    })
    .join("\n");
