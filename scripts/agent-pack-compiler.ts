import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  AgentModuleEntry,
  ControlPlaneRuntimeModule,
  LocalAgentPackManifest,
  RunnerRuntimeModule,
  WebRuntimeModule,
  WorkbenchConfig,
} from "@operloom/agent-sdk";
import {
  assertSchemaDefinition,
  assertSchemaValue,
  compareSemanticVersions,
  isPackVersionCompatible,
  isWorkbenchVersionCompatible,
  parseSemanticVersion,
} from "@operloom/agent-sdk";
import { format } from "oxfmt";
import ts from "typescript";

export type LoadedAgentModule = {
  entry: AgentModuleEntry;
  manifest: LocalAgentPackManifest;
  controlPlane: ControlPlaneRuntimeModule;
  runner: RunnerRuntimeModule;
  web: WebRuntimeModule;
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
  for (const subpath of ["manifest", "control-plane", "runner", "web"] as const) {
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
    loaded.default?.runtimeApiVersion !== 1 ||
    typeof loaded.default.workbenchVersion !== "string" ||
    !parseSemanticVersion(loaded.default.workbenchVersion) ||
    !Array.isArray(loaded.default.modules)
  ) {
    throw new Error("workbench.config.ts must export a Runtime Module v1 configuration.");
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
    const { manifest, controlPlane, runner, web, entry } = item;
    if (manifest.apiVersion !== 2 || manifest.kind !== "agent_pack") {
      throw new Error(`${entry.package} must export a Pack API v2 manifest.`);
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
    for (const runtime of [controlPlane, runner, web]) {
      if (runtime.apiVersion !== 1 || runtime.packId !== manifest.id) {
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
        if (tool.action.approval === "required" && !tool.policy.requiresApproval) {
          throw new Error(
            `${entry.package} tool ${tool.id} action approval contract is inconsistent.`,
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
      if (binding.engine !== declared.engine) {
        throw new Error(`${entry.package} workflow ${declared.type} engine does not match.`);
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
    for (const renderer of manifest.artifactRenderers) {
      if (!webKinds.has(renderer.artifactKind)) {
        throw new Error(`${entry.package} is missing web renderer ${renderer.artifactKind}.`);
      }
      requireUnique(artifactKinds, "Artifact renderer", renderer.artifactKind, manifest.id);
    }
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
  subpath: "manifest" | "control-plane" | "runner" | "web",
  exportName: "manifest" | "controlPlane" | "runner" | "web",
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
  ] as const;
  const files: string[] = [];
  if (!options.check) mkdirSync(outputDirectory, { recursive: true });
  for (const [fileName, subpath, exportName, registryName] of outputs) {
    const outputFile = resolve(outputDirectory, fileName);
    const source = await formatGeneratedSource(
      outputFile,
      renderRegistry(root, outputFile, modules, subpath, exportName, registryName),
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
