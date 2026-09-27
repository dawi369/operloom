import type { LocalAgentPackManifest } from "./types";
import { agentPackProfiles, agentPackToolInvocations } from "./types";
import { agentManifestRegistry } from "../generated/agent-runtime/manifests";

export const localAgentPacks = Object.values(agentManifestRegistry)
  .filter((entry) => !entry.conformanceOnly)
  .map((entry) => entry.module) as readonly LocalAgentPackManifest[];

export type {
  AgentPackArtifactRenderer,
  AgentPackCapabilityLevel,
  AgentPackCompatibility,
  AgentPackConnectionDescriptor,
  AgentPackContextSource,
  AgentPackDeclaredTool,
  AgentPackEval,
  AgentPackExecutionMode,
  AgentPackHealthCheck,
  AgentPackManagedStateDescriptor,
  AgentPackProfile,
  AgentPackResourceLimits,
  AgentPackRisk,
  AgentPackStarter,
  AgentPackToolInvocation,
  AgentPackTrigger,
  AgentPackUiHints,
  AgentPackWorkflow,
  LocalAgentPackManifest,
} from "./types";
export { defineAgentPack } from "./types";
export {
  buildPackWorkflowRequest,
  fieldDefinitionsForPackWorkflow,
  packWorkflowBindings,
  packWorkflowFieldDefinitions,
} from "../lib/agent-runtime/registry";
export type {
  PackWorkflowBinding,
  PackWorkflowFieldDefinition,
  PackWorkflowFieldName,
  PackWorkflowRequest,
  PackWorkflowType,
} from "../lib/agent-runtime/registry";

const semanticVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const descriptorIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

const requireDescriptorId = (packId: string, field: string, value: string) => {
  if (!descriptorIdPattern.test(value)) {
    throw new Error(`Agent pack ${packId} ${field} must be a stable lowercase identifier.`);
  }
};

const requirePositiveInteger = (packId: string, field: string, value: number) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Agent pack ${packId} ${field} must be a positive integer.`);
  }
};

const requireUnique = (packId: string, field: string, values: readonly string[]) => {
  if (new Set(values).size !== values.length) {
    throw new Error(`Agent pack ${packId} ${field} contains duplicate identifiers.`);
  }
};

const assertSerializable = (pack: LocalAgentPackManifest) => {
  const seen = new Set<object>();
  const visit = (value: unknown, path: string) => {
    if (
      value === undefined ||
      typeof value === "function" ||
      typeof value === "symbol" ||
      typeof value === "bigint" ||
      (typeof value === "number" && !Number.isFinite(value))
    ) {
      throw new Error(`Agent pack ${pack.id} ${path} must be JSON-serializable.`);
    }
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) {
      throw new Error(`Agent pack ${pack.id} ${path} must not contain circular references.`);
    }
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
    } else {
      for (const [key, item] of Object.entries(value)) visit(item, `${path}.${key}`);
    }
    seen.delete(value);
  };
  visit(pack, "manifest");
};

export const validateLocalAgentPack = (pack: LocalAgentPackManifest) => {
  const requiredStrings = [
    ["id", pack.id],
    ["templateId", pack.templateId],
    ["name", pack.name],
    ["description", pack.description],
    ["version", pack.version],
    ["folderPath", pack.folderPath],
    ["codePath", pack.codePath],
    ["promptPath", pack.promptPath],
    ["prompt", pack.prompt],
  ] as const;

  for (const [field, value] of requiredStrings) {
    if (!value.trim()) throw new Error(`Agent pack ${field} is required.`);
  }

  if (pack.kind !== "agent_pack") {
    throw new Error(`Agent pack ${pack.id} kind must be "agent_pack".`);
  }
  if (pack.apiVersion !== 2) {
    throw new Error(`Agent pack ${pack.id} apiVersion must be 2.`);
  }
  if (pack.templateId !== `pack-${pack.id}`) {
    throw new Error(`Agent pack ${pack.id} templateId must be derived from its id.`);
  }
  if (!semanticVersionPattern.test(pack.version)) {
    throw new Error(`Agent pack ${pack.id} version must be semantic.`);
  }
  if (!["template", "single_agent_app"].includes(pack.capabilityLevel)) {
    throw new Error(`Agent pack ${pack.id} capabilityLevel is invalid.`);
  }
  if (pack.format !== "xml") {
    throw new Error(`Agent pack ${pack.id} must use XML prompt format.`);
  }
  if (!agentPackProfiles.includes(pack.profile)) {
    throw new Error(`Agent pack ${pack.id} profile is invalid.`);
  }
  if (!pack.prompt.includes("<identity>")) {
    throw new Error(`Agent pack ${pack.id} prompt must include an identity section.`);
  }
  if (pack.risk.requiresSecrets) {
    throw new Error(`Agent pack ${pack.id} cannot require secrets in checked-in pack contract v2.`);
  }
  const toolIds = new Set<string>();
  for (const tool of pack.tools) {
    if (!tool.id.trim()) throw new Error(`Agent pack ${pack.id} tool id is required.`);
    if (toolIds.has(tool.id))
      throw new Error(`Agent pack ${pack.id} tool ${tool.id} is duplicate.`);
    toolIds.add(tool.id);
    if (!agentPackToolInvocations.includes(tool.invocation)) {
      throw new Error(`Agent pack ${pack.id} tool ${tool.id} invocation is invalid.`);
    }
    if (!tool.executionModes.length) {
      throw new Error(`Agent pack ${pack.id} tool ${tool.id} must declare execution modes.`);
    }
    if (tool.executionModes.includes("execute") && !pack.risk.externalMutation) {
      throw new Error(
        `Agent pack ${pack.id} tool ${tool.id} cannot declare execute without externalMutation risk.`,
      );
    }
    if (tool.executionModes.includes("execute") && pack.risk.productionGate === "none") {
      throw new Error(
        `Agent pack ${pack.id} tool ${tool.id} cannot declare execute without a production gate.`,
      );
    }
    if (!tool.purpose.trim()) {
      throw new Error(`Agent pack ${pack.id} tool ${tool.id} purpose is required.`);
    }
  }
  requireUnique(
    pack.id,
    "connections",
    pack.connections.map((connection) => connection.id),
  );
  for (const connection of pack.connections) {
    requireDescriptorId(pack.id, "connection id", connection.id);
    requireDescriptorId(pack.id, `connection ${connection.id} provider`, connection.provider);
    if (!connection.toolIds.length) {
      throw new Error(`Agent pack ${pack.id} connection ${connection.id} must bind a tool.`);
    }
    requireUnique(pack.id, `connection ${connection.id} tools`, connection.toolIds);
    requireUnique(pack.id, `connection ${connection.id} scopes`, connection.scopes);
    for (const toolId of connection.toolIds) {
      if (!toolIds.has(toolId)) {
        throw new Error(
          `Agent pack ${pack.id} connection ${connection.id} references undeclared tool ${toolId}.`,
        );
      }
    }
    const noCredential = connection.credentialClass === "none";
    if (
      (noCredential && (connection.principal !== "none" || connection.custody !== "none")) ||
      (!noCredential &&
        (connection.principal === "none" || connection.custody !== "external_broker"))
    ) {
      throw new Error(`Agent pack ${pack.id} connection ${connection.id} custody is inconsistent.`);
    }
    if (!noCredential && pack.risk.productionGate === "none") {
      throw new Error(
        `Agent pack ${pack.id} connection ${connection.id} requires a production connection gate.`,
      );
    }
  }
  const workflowTypes = new Set(pack.workflows.map((workflow) => workflow.type));
  for (const workflow of pack.workflows) {
    if (!workflow.type.trim()) throw new Error(`Agent pack ${pack.id} workflow type is required.`);
    if (workflow.status !== "declared") {
      throw new Error(`Agent pack ${pack.id} workflow ${workflow.type} must be declared.`);
    }
    if (!workflow.userInvocable) {
      throw new Error(`Agent pack ${pack.id} workflow ${workflow.type} must be user invocable.`);
    }
    if (!workflow.description.trim()) {
      throw new Error(`Agent pack ${pack.id} workflow ${workflow.type} description is required.`);
    }
  }
  requireUnique(
    pack.id,
    "context",
    pack.context.map((source) => source.id),
  );
  for (const source of pack.context) {
    requireDescriptorId(pack.id, "context source id", source.id);
    requireDescriptorId(
      pack.id,
      `context source ${source.id} runtimeBinding`,
      source.runtimeBinding,
    );
    if (!source.description.trim()) {
      throw new Error(`Agent pack ${pack.id} context source ${source.id} description is required.`);
    }
    if (!["trusted", "retrieved", "untrusted"].includes(source.trust)) {
      throw new Error(`Agent pack ${pack.id} context source ${source.id} trust is invalid.`);
    }
  }
  requireUnique(
    pack.id,
    "managedState",
    pack.managedState.map((descriptor) => descriptor.namespace),
  );
  for (const descriptor of pack.managedState) {
    requireDescriptorId(pack.id, "managed-state namespace", descriptor.namespace);
    requirePositiveInteger(
      pack.id,
      `${descriptor.namespace} schemaVersion`,
      descriptor.schemaVersion,
    );
    if (!descriptor.description.trim() || !descriptor.recordKinds.length) {
      throw new Error(`Agent pack ${pack.id} managed state ${descriptor.namespace} is incomplete.`);
    }
    requireUnique(pack.id, `${descriptor.namespace} recordKinds`, descriptor.recordKinds);
    requireUnique(
      pack.id,
      `${descriptor.namespace} views`,
      descriptor.views.map((view) => view.id),
    );
    const recordKinds = new Set(descriptor.recordKinds);
    for (const view of descriptor.views) {
      requireDescriptorId(pack.id, `${descriptor.namespace} view id`, view.id);
      if (!view.title.trim() || !recordKinds.has(view.recordKind)) {
        throw new Error(`Agent pack ${pack.id} managed-state view ${view.id} is invalid.`);
      }
    }
  }
  requireUnique(
    pack.id,
    "triggers",
    pack.triggers.map((trigger) => trigger.id),
  );
  for (const trigger of pack.triggers) {
    requireDescriptorId(pack.id, "trigger id", trigger.id);
    if (!["schedule", "webhook", "monitor"].includes(trigger.kind)) {
      throw new Error(`Agent pack ${pack.id} trigger ${trigger.id} kind is invalid.`);
    }
    if (!trigger.description.trim() || !workflowTypes.has(trigger.workflowType)) {
      throw new Error(`Agent pack ${pack.id} trigger ${trigger.id} is invalid.`);
    }
    if (trigger.enabledByDefault !== false) {
      throw new Error(`Agent pack ${pack.id} trigger ${trigger.id} must be disabled by default.`);
    }
    if (trigger.kind === "schedule" && (!trigger.cron.trim() || !trigger.timezone.trim())) {
      throw new Error(`Agent pack ${pack.id} schedule trigger ${trigger.id} is incomplete.`);
    }
    if (trigger.kind === "webhook" && !trigger.eventType.trim()) {
      throw new Error(`Agent pack ${pack.id} webhook trigger ${trigger.id} eventType is required.`);
    }
    if (trigger.kind === "monitor") {
      requirePositiveInteger(
        pack.id,
        `trigger ${trigger.id} intervalSeconds`,
        trigger.intervalSeconds,
      );
    }
  }
  requireUnique(
    pack.id,
    "artifactRenderers",
    pack.artifactRenderers.map((renderer) => renderer.artifactKind),
  );
  for (const renderer of pack.artifactRenderers) {
    requireDescriptorId(pack.id, "artifact kind", renderer.artifactKind);
    if (!renderer.title.trim() || !["json", "markdown", "table"].includes(renderer.renderer)) {
      throw new Error(
        `Agent pack ${pack.id} artifact renderer ${renderer.artifactKind} is invalid.`,
      );
    }
    requirePositiveInteger(pack.id, `${renderer.artifactKind} renderer version`, renderer.version);
  }
  requireUnique(
    pack.id,
    "healthChecks",
    pack.healthChecks.map((check) => check.id),
  );
  for (const check of pack.healthChecks) {
    requireDescriptorId(pack.id, "health check id", check.id);
    if (!check.description.trim()) {
      throw new Error(`Agent pack ${pack.id} health check ${check.id} description is required.`);
    }
    const targetExists =
      check.target.kind === "tool"
        ? toolIds.has(check.target.id)
        : workflowTypes.has(check.target.type);
    if (!targetExists) {
      throw new Error(`Agent pack ${pack.id} health check ${check.id} target is undeclared.`);
    }
  }
  requireUnique(
    pack.id,
    "evals",
    pack.evals.map((evaluation) => evaluation.id),
  );
  const smokeIds = new Set(pack.smokeScenarios.map((scenario) => scenario.id));
  for (const evaluation of pack.evals) {
    requireDescriptorId(pack.id, "eval id", evaluation.id);
    if (
      !["static_smoke", "deterministic_runtime"].includes(evaluation.kind) ||
      !evaluation.description.trim() ||
      !smokeIds.has(evaluation.scenarioId)
    ) {
      throw new Error(`Agent pack ${pack.id} eval ${evaluation.id} is invalid.`);
    }
  }
  if (pack.compatibility.packApi !== 2) {
    throw new Error(`Agent pack ${pack.id} compatibility.packApi must be 2.`);
  }
  if (!semanticVersionPattern.test(pack.compatibility.minimumWorkbenchVersion)) {
    throw new Error(`Agent pack ${pack.id} minimum workbench compatibility must be semantic.`);
  }
  if (
    pack.compatibility.maximumWorkbenchVersion &&
    !semanticVersionPattern.test(pack.compatibility.maximumWorkbenchVersion)
  ) {
    throw new Error(`Agent pack ${pack.id} maximum workbench compatibility must be semantic.`);
  }
  for (const [field, value] of Object.entries(pack.resourceLimits)) {
    requirePositiveInteger(pack.id, `resourceLimits.${field}`, value);
  }
  if (!["chat", "workbench", "admin"].includes(pack.ui.primarySurface)) {
    throw new Error(`Agent pack ${pack.id} ui.primarySurface is invalid.`);
  }
  if (!["code", "ui_future"].includes(pack.ui.configurationMode)) {
    throw new Error(`Agent pack ${pack.id} ui.configurationMode is invalid.`);
  }
  if (!pack.ui.welcome.title.trim() || !pack.ui.welcome.description.trim()) {
    throw new Error(`Agent pack ${pack.id} ui.welcome title and description are required.`);
  }
  if (![2, 4].includes(pack.ui.welcome.starters.length)) {
    throw new Error(`Agent pack ${pack.id} must declare exactly two or four welcome starters.`);
  }
  const starterIds = new Set<string>();
  for (const starter of pack.ui.welcome.starters) {
    if (!starter.id.trim() || !starter.title.trim() || !starter.description.trim()) {
      throw new Error(`Agent pack ${pack.id} welcome starter fields are required.`);
    }
    if (starterIds.has(starter.id)) {
      throw new Error(`Agent pack ${pack.id} welcome starter ${starter.id} is duplicate.`);
    }
    starterIds.add(starter.id);
    if (starter.action.kind === "message" && !starter.action.prompt.trim()) {
      throw new Error(`Agent pack ${pack.id} welcome starter ${starter.id} prompt is required.`);
    }
    if (starter.action.kind === "workflow" && !workflowTypes.has(starter.action.workflowType)) {
      throw new Error(
        `Agent pack ${pack.id} welcome starter ${starter.id} references an undeclared workflow.`,
      );
    }
  }

  assertSerializable(pack);

  return pack;
};

export const validateLocalAgentPacks = (
  packs: readonly LocalAgentPackManifest[],
): LocalAgentPackManifest[] => {
  const packIds = new Set<string>();
  const templateIds = new Set<string>();
  return packs.map((pack) => {
    if (packIds.has(pack.id)) throw new Error(`Agent pack id ${pack.id} is duplicate.`);
    if (templateIds.has(pack.templateId)) {
      throw new Error(`Agent pack templateId ${pack.templateId} is duplicate.`);
    }
    packIds.add(pack.id);
    templateIds.add(pack.templateId);
    return validateLocalAgentPack(pack);
  });
};

export const loadLocalAgentPacks = (): LocalAgentPackManifest[] =>
  validateLocalAgentPacks(localAgentPacks);
