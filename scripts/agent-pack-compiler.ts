import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  AgentModuleEntry,
  ControlPlaneRuntimeModule,
  LocalAgentPackManifest,
  NativeRuntimeModule,
  RunnerRuntimeModule,
  WebRuntimeModule,
  WorkbenchConfig,
} from "@operloom/agent-sdk";
import {
  assertSchemaDefinition,
  assertRuntimeContextBindings,
  assertRuntimeQueryBindings,
  assertRuntimeSettingsDefinition,
  assertRuntimeStateMigrations,
  assertSchemaValue,
  compareSemanticVersions,
  isPackVersionCompatible,
  isWorkbenchVersionCompatible,
  parseSemanticVersion,
  negotiateRuntimeCapabilities,
} from "@operloom/agent-sdk";
import { format } from "oxfmt";
import ts from "typescript";

export type LoadedAgentModule = {
  entry: AgentModuleEntry;
  manifest: LocalAgentPackManifest;
  controlPlane: ControlPlaneRuntimeModule;
  runner: RunnerRuntimeModule;
  web: WebRuntimeModule;
  /** Present only when the package ships a `native` subpath. */
  native?: NativeRuntimeModule;
  packageMetadata: { name: string; version: string };
};

const pathIsInside = (parent: string, candidate: string) => {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
};

export const resolveAgentModuleImportTarget = (
  root: string,
  entry: AgentModuleEntry,
  subpath: string,
) => {
  if (entry.source) return pathToFileURL(resolve(root, entry.source, `${subpath}.ts`)).href;
  const specifier = `${entry.package}/${subpath}`;
  let resolved: string;
  try {
    resolved = createRequire(resolve(root, "package.json")).resolve(specifier);
  } catch {
    throw new Error(`${specifier} is not installed or does not expose the required subpath.`);
  }
  const localNodeModules = resolve(root, "node_modules");
  const canonicalNodeModules = existsSync(localNodeModules)
    ? realpathSync(localNodeModules)
    : localNodeModules;
  const canonicalResolved = realpathSync(resolved);
  if (!pathIsInside(canonicalNodeModules, canonicalResolved)) {
    throw new Error(
      `${specifier} resolved outside ${relative(process.cwd(), localNodeModules) || "node_modules"}; install it in the consumer instead of relying on workspace hoisting.`,
    );
  }
  return pathToFileURL(resolved).href;
};

const readPackageMetadata = (root: string, entry: AgentModuleEntry) => {
  let directory = entry.source
    ? resolve(root, entry.source)
    : dirname(fileURLToPath(resolveAgentModuleImportTarget(root, entry, "manifest")));
  while (true) {
    const packagePath = resolve(directory, "package.json");
    if (existsSync(packagePath)) {
      const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (typeof parsed.name === "string" && typeof parsed.version === "string") {
        return { name: parsed.name, version: parsed.version };
      }
      throw new Error(`${packagePath} must declare string name and version fields.`);
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`${entry.package} package metadata could not be located.`);
    }
    directory = parent;
  }
};

export const validateInstalledPackageContract = (root: string, entry: AgentModuleEntry) => {
  if (entry.source) return;
  let directory = dirname(
    realpathSync(fileURLToPath(resolveAgentModuleImportTarget(root, entry, "manifest"))),
  );
  while (!existsSync(resolve(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(`${entry.package} package metadata could not be located.`);
    directory = parent;
  }
  const packageJsonPath = resolve(directory, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    exports?: Record<string, unknown>;
  };
  const subpaths = ["manifest", "control-plane", "runner", "web"] as const;
  const optionalSubpaths = packageJson.exports?.["./native"] ? (["native"] as const) : [];
  for (const subpath of [...subpaths, ...optionalSubpaths]) {
    const exportValue = packageJson.exports?.[`./${subpath}`];
    const exportMap =
      exportValue && typeof exportValue === "object" && !Array.isArray(exportValue)
        ? (exportValue as Record<string, unknown>)
        : null;
    if (!exportMap || typeof exportMap.types !== "string") {
      throw new Error(
        `${entry.package}/${subpath} must expose a declaration file through exports.types.`,
      );
    }
    const declarationPath = resolve(directory, exportMap.types);
    if (!existsSync(declarationPath)) {
      throw new Error(`${entry.package}/${subpath} declaration file is missing.`);
    }
    const source = ts.createSourceFile(
      declarationPath,
      readFileSync(declarationPath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const parseDiagnostics = (
      source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
    ).parseDiagnostics;
    if (parseDiagnostics?.length) {
      throw new Error(`${entry.package}/${subpath} declaration file is invalid.`);
    }
  }
};

/** A package opts into native renderers by exposing `./native`; source entries by shipping `native.ts`. */
export const hasNativeModule = (root: string, entry: AgentModuleEntry) => {
  if (entry.source) return existsSync(resolve(root, entry.source, "native.ts"));
  try {
    createRequire(resolve(root, "package.json")).resolve(`${entry.package}/native`);
    return true;
  } catch {
    return false;
  }
};

const loadExport = async <T>(
  root: string,
  entry: AgentModuleEntry,
  subpath: string,
  exportName: string,
): Promise<T> => {
  const target = resolveAgentModuleImportTarget(root, entry, subpath);
  const loaded = (await import(target)) as Record<string, unknown>;
  const value = loaded[exportName];
  if (!value) throw new Error(`${entry.package}/${subpath} must export ${exportName}.`);
  return value as T;
};

export const loadWorkbenchConfig = async (root: string): Promise<WorkbenchConfig> => {
  const target = `${pathToFileURL(resolve(root, "workbench.config.ts")).href}?t=${Date.now()}`;
  const loaded = (await import(target)) as { default?: WorkbenchConfig };
  if (
    loaded.default?.runtimeApiVersion !== 2 ||
    typeof loaded.default.workbenchVersion !== "string" ||
    !parseSemanticVersion(loaded.default.workbenchVersion) ||
    !Array.isArray(loaded.default.modules)
  ) {
    throw new Error("workbench.config.ts must export a runtimeApiVersion 2 configuration.");
  }
  return loaded.default;
};

const requireUnique = (seen: Map<string, string>, kind: string, id: string, packId: string) => {
  const owner = seen.get(id);
  if (owner) throw new Error(`${kind} ${id} is declared by both ${owner} and ${packId}.`);
  seen.set(id, packId);
};

export const validateLoadedModules = (
  modules: readonly LoadedAgentModule[],
  workbenchVersion: string,
) => {
  const parsedWorkbenchVersion = parseSemanticVersion(workbenchVersion);
  if (!parsedWorkbenchVersion) {
    throw new Error(`Workbench version ${workbenchVersion} is not valid semantic versioning.`);
  }
  const packIds = new Map<string, string>();
  const toolIds = new Map<string, string>();
  const workflowTypes = new Map<string, string>();
  const artifactKinds = new Map<string, string>();
  for (const item of modules) {
    const { manifest, controlPlane, runner, web, native, entry } = item;
    if (manifest.apiVersion !== 2 || manifest.kind !== "agent_pack") {
      throw new Error(`${entry.package} must export an Agent Pack manifest (apiVersion 2).`);
    }
    const minimumWorkbenchVersion = parseSemanticVersion(
      manifest.compatibility.minimumWorkbenchVersion,
    );
    const maximumWorkbenchVersion = manifest.compatibility.maximumWorkbenchVersion
      ? parseSemanticVersion(manifest.compatibility.maximumWorkbenchVersion)
      : undefined;
    if (!minimumWorkbenchVersion) {
      throw new Error(`${entry.package} declares a malformed minimum workbench version.`);
    }
    if (manifest.compatibility.maximumWorkbenchVersion && !maximumWorkbenchVersion) {
      throw new Error(`${entry.package} declares a malformed maximum workbench version.`);
    }
    if (
      maximumWorkbenchVersion &&
      compareSemanticVersions(minimumWorkbenchVersion, maximumWorkbenchVersion) > 0
    ) {
      throw new Error(`${entry.package} declares an inverted workbench compatibility range.`);
    }
    if (
      !isWorkbenchVersionCompatible(
        workbenchVersion,
        manifest.compatibility.minimumWorkbenchVersion,
        manifest.compatibility.maximumWorkbenchVersion,
      )
    ) {
      throw new Error(`${entry.package} is incompatible with workbench ${workbenchVersion}.`);
    }
    if (item.packageMetadata.name !== entry.package) {
      throw new Error(
        `${entry.package} resolves package metadata for ${item.packageMetadata.name}.`,
      );
    }
    if (item.packageMetadata.version !== manifest.version) {
      throw new Error(
        `${entry.package} package version ${item.packageMetadata.version} does not match manifest ${manifest.version}.`,
      );
    }
    requireUnique(packIds, "Pack id", manifest.id, entry.package);
    for (const runtime of native
      ? [controlPlane, runner, web, native]
      : [controlPlane, runner, web]) {
      if (runtime.apiVersion !== 2 || runtime.packId !== manifest.id) {
        throw new Error(`${entry.package} runtime exports must identify pack ${manifest.id}.`);
      }
      if (
        runtime.runtimeVersion !== controlPlane.runtimeVersion ||
        runtime.compatiblePackVersions !== controlPlane.compatiblePackVersions
      ) {
        throw new Error(`${entry.package} must deploy one consistent runtime version.`);
      }
      if (!isPackVersionCompatible(manifest.version, runtime.compatiblePackVersions)) {
        throw new Error(
          `${entry.package} runtime ${runtime.runtimeVersion} is incompatible with pack ${manifest.version}.`,
        );
      }
    }
    if (
      !controlPlane.requirements ||
      typeof controlPlane.requirements.minimumBackendVersion !== "string" ||
      !Array.isArray(controlPlane.requirements.capabilities) ||
      controlPlane.requirements.capabilities.some(
        (capability) => typeof capability !== "string" || !capability.trim(),
      )
    ) {
      throw new Error(`${entry.package} must declare valid runtime requirements.`);
    }
    const capabilities = controlPlane.requirements.capabilities;
    for (const state of controlPlane.state ?? [])
      assertSchemaDefinition(
        state.schema,
        `${entry.package} state ${state.namespace}/${state.kind}`,
      );
    if (controlPlane.context?.length || capabilities.includes("context.snapshots")) {
      if (!capabilities.includes("context.snapshots"))
        throw new Error(`${entry.package} must require context.snapshots for executable context.`);
      assertRuntimeContextBindings(manifest.context, controlPlane.context ?? []);
    }
    const negotiation = negotiateRuntimeCapabilities(controlPlane.requirements, workbenchVersion);
    assertRuntimeStateMigrations(controlPlane.state ?? [], controlPlane.stateMigrations ?? []);
    if (controlPlane.stateMigrations?.length && !capabilities.includes("state.migrations"))
      throw new Error(`${entry.package} must require state.migrations for declared migrations.`);
    if (controlPlane.settings !== undefined)
      assertRuntimeSettingsDefinition(controlPlane.settings, `${entry.package} settings`);
    if (controlPlane.queries !== undefined)
      assertRuntimeQueryBindings(controlPlane.queries, `${entry.package} queries`);
    if (!negotiation.ok) throw new Error(`${entry.package}: ${negotiation.message}`);
    const limits = manifest.resourceLimits;
    for (const [key, bound] of [
      ["maxDelegationDepth", 8],
      ["maxDelegationFanOut", 32],
    ] as const) {
      const value = (limits as Record<string, unknown>)[key];
      if (
        value !== undefined &&
        (!Number.isInteger(value) || Number(value) < 1 || Number(value) > bound)
      )
        throw new Error(
          `${entry.package} resourceLimits.${key} must be an integer between 1 and ${bound}.`,
        );
    }
    for (const workflow of manifest.workflows)
      if (workflow.delegable !== undefined && typeof workflow.delegable !== "boolean")
        throw new Error(`${entry.package} workflow ${workflow.type} delegable must be boolean.`);
    const notifications = manifest.notifications ?? [];
    if (notifications.length && !capabilities.includes("notifications.emit"))
      throw new Error(
        `${entry.package} must require notifications.emit for declared notifications.`,
      );
    if (!notifications.length && capabilities.includes("notifications.emit"))
      throw new Error(
        `${entry.package} requires notifications.emit but declares no notifications.`,
      );
    const notificationTypes = new Set<string>();
    for (const notification of notifications) {
      if (
        typeof notification.type !== "string" ||
        !/^[a-z][a-z0-9_.-]{2,63}$/.test(notification.type) ||
        typeof notification.description !== "string" ||
        !notification.description.trim() ||
        !Array.isArray(notification.defaultChannels) ||
        notification.defaultChannels.some(
          (channel) => !["push", "email", "sms"].includes(channel),
        ) ||
        new Set(notification.defaultChannels).size !== notification.defaultChannels.length
      )
        throw new Error(`${entry.package} notification ${String(notification?.type)} is invalid.`);
      if (notificationTypes.has(notification.type))
        throw new Error(`${entry.package} notification ${notification.type} is declared twice.`);
      notificationTypes.add(notification.type);
    }
    const providerOperations = controlPlane.providerOperations ?? [];
    if (providerOperations.length && !capabilities.includes("actions.provider_operations"))
      throw new Error(
        `${entry.package} must require actions.provider_operations for declared provider operations.`,
      );
    const operationKeys = new Set<string>();
    for (const operation of providerOperations) {
      const label = `${entry.package} provider operation ${String(operation?.id)}`;
      if (
        typeof operation.id !== "string" ||
        !/^[a-z][a-z0-9.-]{0,127}$/.test(operation.id) ||
        typeof operation.version !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(operation.version) ||
        typeof operation.providerId !== "string" ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(operation.providerId) ||
        !["bearer", "hmac-sha256"].includes(operation.auth) ||
        !["POST", "PUT", "PATCH", "DELETE"].includes(operation.method) ||
        typeof operation.path !== "string" ||
        !/^\/[a-zA-Z0-9/_.-]{0,255}$/.test(operation.path) ||
        !Number.isInteger(operation.timeoutMs) ||
        operation.timeoutMs < 1 ||
        !Number.isInteger(operation.maxResponseBytes) ||
        operation.maxResponseBytes < 1
      )
        throw new Error(`${label} declaration is invalid.`);
      const key = `${operation.id}@${operation.version}`;
      if (operationKeys.has(key)) throw new Error(`${label} is declared twice.`);
      operationKeys.add(key);
      assertSchemaDefinition(operation.inputSchema, `${label} input`);
      assertSchemaDefinition(operation.outputSchema, `${label} output`);
      const properties = operation.outputSchema.properties;
      if (
        operation.outputSchema.type !== "object" ||
        operation.outputSchema.additionalProperties !== false ||
        !properties ||
        typeof properties !== "object" ||
        Array.isArray(properties)
      )
        throw new Error(`${label} output must be a closed object schema.`);
      const fields = Object.keys(properties as Record<string, unknown>);
      const receipt = operation.receipt;
      if (
        !receipt ||
        !fields.includes(receipt.requestIdField) ||
        !fields.includes(receipt.statusField) ||
        (receipt.referenceField !== undefined && !fields.includes(receipt.referenceField)) ||
        !Array.isArray(receipt.rejectedValues) ||
        receipt.rejectedValues.some((value) => typeof value !== "string")
      )
        throw new Error(`${label} receipt fields must exist in the output schema.`);
    }
    const controlPlaneTools = new Map(controlPlane.tools.map((tool) => [tool.id, tool]));
    const runnerTools = new Map(runner.tools.map((tool) => [tool.id, tool]));
    if (controlPlaneTools.size !== controlPlane.tools.length) {
      throw new Error(`${entry.package} registers duplicate control-plane tool providers.`);
    }
    if (runnerTools.size !== runner.tools.length) {
      throw new Error(`${entry.package} registers duplicate runner tool providers.`);
    }
    for (const tool of controlPlane.tools) {
      assertSchemaDefinition(tool.inputSchema, `${entry.package} tool ${tool.id} input`);
      assertSchemaDefinition(tool.outputSchema, `${entry.package} tool ${tool.id} output`);
      if (!tool.executionModes.length) {
        throw new Error(`${entry.package} tool ${tool.id} has no supported execution mode.`);
      }
      if (tool.executionModes.some((mode) => !["ask", "dry_run", "execute"].includes(mode))) {
        throw new Error(`${entry.package} tool ${tool.id} declares an unsupported execution mode.`);
      }
      if (tool.executionModes.includes("execute")) {
        if (!manifest.risk.externalMutation || manifest.risk.productionGate === "none") {
          throw new Error(`${entry.package} tool ${tool.id} execute mode lacks a mutation gate.`);
        }
        if (!tool.action) {
          throw new Error(`${entry.package} tool ${tool.id} execute mode lacks an action binding.`);
        }
      }
      if (tool.action) {
        if (
          tool.action.providerOperation &&
          (tool.transport !== "cloudflare_inline" ||
            !tool.action.connectionId ||
            tool.action.execute ||
            tool.action.reconcile ||
            !tool.policy.requiresApproval ||
            typeof tool.action.providerOperation.id !== "string" ||
            typeof tool.action.providerOperation.version !== "string" ||
            !/^[a-z][a-z0-9.-]{0,127}$/.test(tool.action.providerOperation.id) ||
            !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(tool.action.providerOperation.version))
        )
          throw new Error(
            `${entry.package} provider operations require inline bindings, a connection and approval, without package execution callbacks.`,
          );
        if (tool.action.providerOperation) {
          const reference = tool.action.providerOperation;
          const operation = providerOperations.find(
            (item) => item.id === reference.id && item.version === reference.version,
          );
          if (!operation)
            throw new Error(
              `${entry.package} tool ${tool.id} references undeclared provider operation ${reference.id}@${reference.version}.`,
            );
          const connection = manifest.connections.find(
            (candidate) => candidate.id === tool.action?.connectionId,
          );
          if (connection && connection.provider !== operation.providerId)
            throw new Error(
              `${entry.package} tool ${tool.id} connection provider does not match operation provider ${operation.providerId}.`,
            );
          if (connection && connection.credentialClass !== "api_key")
            throw new Error(
              `${entry.package} tool ${tool.id} provider operation requires an api_key connection.`,
            );
        }
        // Simulators run inline in the Worker for every transport, including runner bindings.
        if (tool.action.simulate !== undefined && typeof tool.action.simulate !== "function")
          throw new Error(`${entry.package} action ${tool.id} simulate must be a function.`);
        assertSchemaDefinition(
          tool.action.proposalSchema,
          `${entry.package} tool ${tool.id} proposal`,
        );
        assertSchemaDefinition(
          tool.action.resultSchema,
          `${entry.package} tool ${tool.id} action result`,
        );
        if (tool.action.idempotency !== "required") {
          throw new Error(`${entry.package} tool ${tool.id} action must require idempotency.`);
        }
        if (
          !Number.isInteger(tool.action.timeoutMs) ||
          tool.action.timeoutMs < 1 ||
          tool.action.timeoutMs > tool.timeoutMs
        ) {
          throw new Error(
            `${entry.package} tool ${tool.id} action timeout must fit within the tool timeout.`,
          );
        }
        if (!tool.policy.requiresApproval) {
          throw new Error(
            `${entry.package} tool ${tool.id} action approval contract is inconsistent.`,
          );
        }
        if (tool.action.approval === "policy_controlled") {
          const limits = tool.action.policy?.limits;
          if (!capabilities.includes("actions.policy_controlled"))
            throw new Error(
              `${entry.package} must require actions.policy_controlled for policy-controlled actions.`,
            );
          if (!Array.isArray(limits) || limits.length === 0)
            throw new Error(
              `${entry.package} tool ${tool.id} policy_controlled approval needs at least one limit.`,
            );
          const settingsProperties = controlPlane.settings?.schema.properties;
          for (const limit of limits) {
            const period = "per" in limit ? limit.per : undefined;
            const valid =
              (limit.kind === "count" &&
                ["hour", "day"].includes(String(period)) &&
                Number.isInteger(limit.max) &&
                limit.max >= 1) ||
              (limit.kind === "amount" &&
                typeof limit.field === "string" &&
                /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(limit.field) &&
                (period === undefined || ["hour", "day"].includes(String(period))) &&
                typeof limit.max === "number" &&
                Number.isFinite(limit.max) &&
                limit.max > 0) ||
              (limit.kind === "allowlist" &&
                typeof limit.field === "string" &&
                /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(limit.field) &&
                typeof limit.settingsKey === "string" &&
                Boolean(settingsProperties) &&
                Object.prototype.hasOwnProperty.call(settingsProperties, limit.settingsKey));
            if (!valid)
              throw new Error(
                `${entry.package} tool ${tool.id} declares an invalid ${String(limit.kind)} approval limit.`,
              );
          }
        } else if (tool.action.policy !== undefined) {
          throw new Error(
            `${entry.package} tool ${tool.id} declares approval limits without policy_controlled approval.`,
          );
        }
        if (tool.action.connectionId) {
          const connection = manifest.connections.find(
            (candidate) =>
              candidate.id === tool.action?.connectionId && candidate.toolIds.includes(tool.id),
          );
          if (!connection || connection.credentialClass === "none") {
            throw new Error(`${entry.package} tool ${tool.id} action connection is undeclared.`);
          }
        }
      }
      const runnerTool = runnerTools.get(tool.id);
      if (tool.transport === "fly") {
        if (!runnerTool) {
          throw new Error(`${entry.package} is missing runner binding for ${tool.id}.`);
        }
        const contract = (value: typeof tool) => ({
          id: value.id,
          description: value.description,
          inputSchema: value.inputSchema,
          outputSchema: value.outputSchema,
          executionModes: value.executionModes,
          transport: value.transport,
          adapterVersion: value.adapterVersion,
          timeoutMs: value.timeoutMs,
          maxArtifactBytes: value.maxArtifactBytes,
          sandbox: value.sandbox,
          policy: value.policy,
          action: value.action
            ? {
                connectionId: value.action.connectionId,
                proposalSchema: value.action.proposalSchema,
                resultSchema: value.action.resultSchema,
                idempotency: value.action.idempotency,
                approval: value.action.approval,
                timeoutMs: value.action.timeoutMs,
                hasReconcile: Boolean(value.action.reconcile),
              }
            : undefined,
        });
        if (JSON.stringify(contract(tool)) !== JSON.stringify(contract(runnerTool))) {
          throw new Error(`${entry.package} runner contract does not match ${tool.id}.`);
        }
      } else if (runnerTool) {
        throw new Error(`${entry.package} inline tool ${tool.id} cannot have a runner binding.`);
      }
    }
    for (const runnerTool of runner.tools) {
      if (!controlPlaneTools.has(runnerTool.id)) {
        throw new Error(
          `${entry.package} runner tool ${runnerTool.id} lacks a control-plane declaration.`,
        );
      }
      if (!runnerTool.execute) {
        throw new Error(`${entry.package} runner tool ${runnerTool.id} is not executable.`);
      }
    }
    for (const toolId of controlPlaneTools.keys()) {
      requireUnique(toolIds, "Tool", toolId, manifest.id);
    }
    for (const declared of manifest.tools) {
      if (!controlPlaneTools.has(declared.id)) {
        throw new Error(`${entry.package} is missing runtime provider for tool ${declared.id}.`);
      }
    }
    const workflows = new Map(controlPlane.workflows.map((workflow) => [workflow.type, workflow]));
    for (const declared of manifest.workflows) {
      const binding = workflows.get(declared.type);
      if (!binding) {
        throw new Error(`${entry.package} is missing workflow binding ${declared.type}.`);
      }
      if (binding.execute && !capabilities.includes("workflow.request"))
        throw new Error(
          `${entry.package} workflow ${declared.type} must require workflow.request for request-mode execution.`,
        );
      if (binding.durable) {
        const durable = binding.durable;
        if (
          !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(durable.version) ||
          typeof durable.execute !== "function" ||
          !Number.isInteger(durable.maxSteps) ||
          durable.maxSteps < 1 ||
          durable.maxSteps > 128 ||
          !Number.isInteger(durable.maxDurationMs) ||
          durable.maxDurationMs < 1 ||
          durable.maxDurationMs > 604800000
        )
          throw new Error(
            `${entry.package} workflow ${declared.type} has an invalid durable binding.`,
          );
      }
      assertSchemaDefinition(
        binding.inputSchema,
        `${entry.package} workflow ${declared.type} input`,
      );
      assertSchemaDefinition(
        binding.outputSchema,
        `${entry.package} workflow ${declared.type} output`,
      );
      const properties =
        binding.inputSchema.properties && typeof binding.inputSchema.properties === "object"
          ? (binding.inputSchema.properties as Record<string, Record<string, unknown>>)
          : {};
      const required = Array.isArray(binding.inputSchema.required)
        ? binding.inputSchema.required.filter((name): name is string => typeof name === "string")
        : [];
      for (const name of required) {
        if (
          properties[name]?.default === undefined &&
          !Object.prototype.hasOwnProperty.call(binding.conformanceInput ?? {}, name)
        ) {
          throw new Error(
            `${entry.package} workflow ${declared.type} requires conformanceInput.${name}.`,
          );
        }
      }
      const conformanceDefaults = Object.fromEntries(
        Object.entries(properties)
          .filter(([, schema]) => schema.default !== undefined)
          .map(([name, schema]) => [name, schema.default]),
      );
      const conformanceInput = {
        ...conformanceDefaults,
        ...binding.conformanceInput,
      };
      assertSchemaValue(
        binding.inputSchema,
        binding.normalizeInput ? binding.normalizeInput(conformanceInput) : conformanceInput,
        `${entry.package} workflow ${declared.type} conformance input`,
      );
      requireUnique(workflowTypes, "Workflow", declared.type, manifest.id);
      for (const toolId of binding.toolIds) {
        if (!controlPlaneTools.has(toolId)) {
          throw new Error(
            `${entry.package} workflow ${declared.type} uses missing tool ${toolId}.`,
          );
        }
      }
    }
    const webKinds = new Set(Object.keys(web.artifactRenderers));
    const validBound = (value: unknown) =>
      value === undefined ||
      (Number.isInteger(value) && Number(value) >= 1024 && Number(value) <= 1_048_576);
    for (const renderer of manifest.artifactRenderers) {
      if (!webKinds.has(renderer.artifactKind)) {
        throw new Error(`${entry.package} is missing web renderer ${renderer.artifactKind}.`);
      }
      requireUnique(artifactKinds, "Artifact renderer", renderer.artifactKind, manifest.id);
      const component = (web.artifactRenderers as Record<string, unknown>)[renderer.artifactKind];
      if (renderer.renderer === "module" && typeof component !== "function")
        throw new Error(
          `${entry.package} artifact renderer ${renderer.artifactKind} is declared as module but the web module supplies no component.`,
        );
      if (renderer.renderer !== "module" && typeof component === "function")
        throw new Error(
          `${entry.package} artifact renderer ${renderer.artifactKind} supplies a component; declare renderer: "module".`,
        );
      if (!validBound(renderer.maxBytes))
        throw new Error(
          `${entry.package} artifact renderer ${renderer.artifactKind} maxBytes is out of range.`,
        );
    }
    if (native) {
      if (native.kind !== "agent_native_module")
        throw new Error(`${entry.package}/native must export an agent_native_module.`);
      const declaredKinds = new Set(manifest.artifactRenderers.map((item) => item.artifactKind));
      for (const [kind, component] of Object.entries(native.artifactRenderers)) {
        if (!declaredKinds.has(kind))
          throw new Error(
            `${entry.package} native artifact renderer ${kind} is not declared in the manifest.`,
          );
        if (typeof component !== "function")
          throw new Error(`${entry.package} native artifact renderer ${kind} must be a component.`);
      }
    }
    const toolResultRenderers = manifest.toolResultRenderers ?? [];
    const webToolRenderers = (web.toolResultRenderers ?? {}) as Record<string, unknown>;
    const declaredToolRenderers = new Set<string>();
    for (const renderer of toolResultRenderers) {
      if (!manifest.tools.some((tool) => tool.id === renderer.toolId))
        throw new Error(
          `${entry.package} tool result renderer ${renderer.toolId} names an undeclared tool.`,
        );
      if (declaredToolRenderers.has(renderer.toolId))
        throw new Error(
          `${entry.package} tool result renderer ${renderer.toolId} is declared twice.`,
        );
      declaredToolRenderers.add(renderer.toolId);
      if (typeof webToolRenderers[renderer.toolId] !== "function")
        throw new Error(`${entry.package} is missing web tool result renderer ${renderer.toolId}.`);
      if (
        !Number.isInteger(renderer.version) ||
        renderer.version < 1 ||
        !validBound(renderer.maxBytes)
      )
        throw new Error(`${entry.package} tool result renderer ${renderer.toolId} is invalid.`);
    }
    for (const toolId of Object.keys(webToolRenderers))
      if (!declaredToolRenderers.has(toolId))
        throw new Error(
          `${entry.package} web tool result renderer ${toolId} is not declared in the manifest.`,
        );
    const healthIds = new Set(controlPlane.health.map((binding) => binding.id));
    for (const check of manifest.healthChecks) {
      if (!healthIds.has(check.id)) {
        throw new Error(`${entry.package} is missing health binding ${check.id}.`);
      }
    }
    const evalIds = new Set(controlPlane.evals.map((binding) => binding.id));
    for (const evaluation of manifest.evals) {
      if (!evalIds.has(evaluation.id)) {
        throw new Error(`${entry.package} is missing eval binding ${evaluation.id}.`);
      }
    }
  }
  return modules;
};

export const loadAgentModules = async (root: string): Promise<LoadedAgentModule[]> => {
  const config = await loadWorkbenchConfig(root);
  const entries = config.modules.filter((entry) => entry.enabled !== false);
  const modules = await Promise.all(
    entries.map(async (entry) => {
      validateInstalledPackageContract(root, entry);
      return {
        entry,
        packageMetadata: readPackageMetadata(root, entry),
        manifest: await loadExport<LocalAgentPackManifest>(root, entry, "manifest", "manifest"),
        controlPlane: await loadExport<ControlPlaneRuntimeModule>(
          root,
          entry,
          "control-plane",
          "controlPlane",
        ),
        runner: await loadExport<RunnerRuntimeModule>(root, entry, "runner", "runner"),
        web: await loadExport<WebRuntimeModule>(root, entry, "web", "web"),
        ...(hasNativeModule(root, entry)
          ? { native: await loadExport<NativeRuntimeModule>(root, entry, "native", "native") }
          : {}),
      };
    }),
  );
  return [...validateLoadedModules(modules, config.workbenchVersion)];
};

const sourceSpecifier = (
  root: string,
  outputFile: string,
  entry: AgentModuleEntry,
  subpath: string,
) => {
  if (!entry.source) return `${entry.package}/${subpath}`;
  const target = resolve(root, entry.source, subpath);
  let value = relative(dirname(outputFile), target).split(sep).join("/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
};

const header = `// Generated by pnpm agent-packs:compile. Do not edit.\n`;

const formatGeneratedSource = async (fileName: string, source: string) => {
  const formatted = await format(fileName, source);
  const errors = formatted.errors.filter((error) => error.severity === "Error");
  if (errors.length) {
    throw new Error(
      `Could not format ${fileName}: ${errors.map((error) => error.message).join("; ")}`,
    );
  }
  return formatted.code;
};

const renderRegistry = (
  root: string,
  outputFile: string,
  modules: readonly LoadedAgentModule[],
  subpath: "manifest" | "control-plane" | "runner" | "web" | "native",
  exportName: "manifest" | "controlPlane" | "runner" | "web" | "native",
  registryName: string,
) => {
  const imports = modules
    .map(
      (item, index) =>
        `import { ${exportName} as module${index} } from ${JSON.stringify(
          sourceSpecifier(root, outputFile, item.entry, subpath),
        )};`,
    )
    .join("\n");
  const entries = modules
    .map(
      (item, index) =>
        `  ${JSON.stringify(item.manifest.id)}: { module: module${index}, package: ${JSON.stringify(
          item.entry.package,
        )}, conformanceOnly: ${item.entry.conformanceOnly === true} },`,
    )
    .join("\n");
  return `${header}${imports}\n\nexport const ${registryName} = {\n${entries}\n} as const;\n`;
};

const renderConformance = (modules: readonly LoadedAgentModule[]) => {
  const rows = modules
    .flatMap((item) => [
      ...item.manifest.healthChecks.map((check) => ({
        id: `${item.manifest.id}.health.${check.id}`,
        packId: item.manifest.id,
        kind: "health",
        required: check.required,
      })),
      ...item.manifest.evals.map((evaluation) => ({
        id: `${item.manifest.id}.eval.${evaluation.id}`,
        packId: item.manifest.id,
        kind: "eval",
        required: evaluation.required,
      })),
    ])
    .sort((left, right) => left.id.localeCompare(right.id));
  return `${header}export const agentConformanceRegistry = ${JSON.stringify(rows, null, 2)} as const;\n`;
};

const renderPlatform = (workbenchVersion: string) =>
  `${header}export const compiledWorkbenchVersion = ${JSON.stringify(workbenchVersion)} as const;\n`;

export const compileAgentPacks = async (
  root: string,
  options: { check: boolean },
): Promise<{ modules: LoadedAgentModule[]; files: string[] }> => {
  const config = await loadWorkbenchConfig(root);
  const modules = await loadAgentModules(root);
  const outputDirectory = resolve(root, "generated/agent-runtime");
  const outputs = [
    ["manifests.ts", "manifest", "manifest", "agentManifestRegistry"],
    ["control-plane.ts", "control-plane", "controlPlane", "agentControlPlaneRegistry"],
    ["runner.ts", "runner", "runner", "agentRunnerRegistry"],
    ["web.ts", "web", "web", "agentWebRegistry"],
    ["native.ts", "native", "native", "agentNativeRegistry"],
  ] as const;
  const files: string[] = [];
  if (!options.check) mkdirSync(outputDirectory, { recursive: true });
  for (const [fileName, subpath, exportName, registryName] of outputs) {
    const outputFile = resolve(outputDirectory, fileName);
    const included = subpath === "native" ? modules.filter((item) => item.native) : modules;
    const source = await formatGeneratedSource(
      outputFile,
      renderRegistry(root, outputFile, included, subpath, exportName, registryName),
    );
    if (options.check) {
      if (!existsSync(outputFile) || readFileSync(outputFile, "utf8") !== source) {
        throw new Error(`${relative(root, outputFile)} is stale; run pnpm agent-packs:compile.`);
      }
    } else {
      writeFileSync(outputFile, source);
    }
    files.push(outputFile);
  }
  const conformanceFile = resolve(outputDirectory, "conformance.ts");
  const conformanceSource = await formatGeneratedSource(
    conformanceFile,
    renderConformance(modules),
  );
  if (options.check) {
    if (
      !existsSync(conformanceFile) ||
      readFileSync(conformanceFile, "utf8") !== conformanceSource
    ) {
      throw new Error(`${relative(root, conformanceFile)} is stale; run pnpm agent-packs:compile.`);
    }
  } else {
    writeFileSync(conformanceFile, conformanceSource);
  }
  files.push(conformanceFile);
  const platformFile = resolve(outputDirectory, "platform.ts");
  const platformSource = await formatGeneratedSource(
    platformFile,
    renderPlatform(config.workbenchVersion),
  );
  if (options.check) {
    if (!existsSync(platformFile) || readFileSync(platformFile, "utf8") !== platformSource) {
      throw new Error(`${relative(root, platformFile)} is stale; run pnpm agent-packs:compile.`);
    }
  } else {
    writeFileSync(platformFile, platformSource);
  }
  files.push(platformFile);
  return { modules, files };
};
