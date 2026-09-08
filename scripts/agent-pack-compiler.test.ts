import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadAgentModules,
  resolveAgentModuleImportTarget,
  validateInstalledPackageContract,
  validateLoadedModules as validateLoadedModulesForWorkbench,
} from "./agent-pack-compiler";

const validateLoadedModules = (
  modules: Parameters<typeof validateLoadedModulesForWorkbench>[0],
  workbenchVersion = "1.0.0",
) => validateLoadedModulesForWorkbench(modules, workbenchVersion);

const temporaryRoots: string[] = [];
const temporaryRoot = () => {
  const root = mkdtempSync(resolve(tmpdir(), "operloom-pack-"));
  temporaryRoots.push(root);
  writeFileSync(resolve(root, "package.json"), '{"type":"module"}\n');
  return root;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent pack compiler", () => {
  it("loads the configured modules and verifies complete bindings", async () => {
    const modules = await loadAgentModules(process.cwd());
    expect(modules.map((item) => item.manifest.id)).toEqual([
      "repo-analyst",
      "baby-polymancer",
      "baby-swordfish",
      "complex-operator",
    ]);
    expect(
      modules.every((item) => item.controlPlane.runtimeVersion === item.web.runtimeVersion),
    ).toBe(true);
  });

  it("rejects registry collisions", async () => {
    const modules = await loadAgentModules(process.cwd());
    const duplicate = {
      ...modules[1]!,
      manifest: { ...modules[1]!.manifest, id: modules[0]!.manifest.id },
    };
    expect(() => validateLoadedModules([modules[0]!, duplicate])).toThrow("Pack id");
  });

  it("rejects package and manifest version drift", async () => {
    const modules = await loadAgentModules(process.cwd());
    const mismatch = {
      ...modules[0]!,
      packageMetadata: { ...modules[0]!.packageMetadata, version: "9.9.9" },
    };
    expect(() => validateLoadedModules([mismatch])).toThrow("does not match manifest");
  });

  it("accepts exact, minimum-only, and bounded workbench compatibility", async () => {
    const [source] = await loadAgentModules(process.cwd());
    if (!source) throw new Error("At least one pack must be configured.");
    const withCompatibility = (
      minimumWorkbenchVersion: string,
      maximumWorkbenchVersion?: string,
    ) => [
      {
        ...source,
        manifest: {
          ...source.manifest,
          compatibility: {
            ...source.manifest.compatibility,
            minimumWorkbenchVersion,
            ...(maximumWorkbenchVersion ? { maximumWorkbenchVersion } : {}),
          },
        },
      },
    ];

    expect(() => validateLoadedModules(withCompatibility("1.0.0"))).not.toThrow();
    expect(() => validateLoadedModules(withCompatibility("0.9.0"))).not.toThrow();
    expect(() => validateLoadedModules(withCompatibility("0.9.0", "1.0.0"))).not.toThrow();
  });

  it("rejects malformed and incompatible workbench declarations", async () => {
    const [source] = await loadAgentModules(process.cwd());
    if (!source) throw new Error("At least one pack must be configured.");
    const changed = (minimumWorkbenchVersion: string, maximumWorkbenchVersion?: string) => [
      {
        ...source,
        manifest: {
          ...source.manifest,
          compatibility: {
            ...source.manifest.compatibility,
            minimumWorkbenchVersion,
            ...(maximumWorkbenchVersion ? { maximumWorkbenchVersion } : {}),
          },
        },
      },
    ];

    expect(() => validateLoadedModules(changed("later"))).toThrow("malformed minimum");
    expect(() => validateLoadedModules(changed("1.1.0"))).toThrow("incompatible with workbench");
    expect(() => validateLoadedModules(changed("0.9.0", "0.9.9"))).toThrow(
      "incompatible with workbench",
    );
    expect(() => validateLoadedModules(changed("1.1.0", "1.0.0"))).toThrow(
      "inverted workbench compatibility range",
    );
  });

  it("requires valid conformance input for workflows without defaults", async () => {
    const modules = await loadAgentModules(process.cwd());
    const source = modules.find((module) => module.controlPlane.workflows.length > 0);
    if (!source) throw new Error("At least one workflow pack must be configured.");
    const workflow = source.controlPlane.workflows[0]!;
    const changed = {
      ...source,
      controlPlane: {
        ...source.controlPlane,
        workflows: [
          {
            ...workflow,
            inputSchema: {
              type: "object",
              required: ["scope"],
              additionalProperties: false,
              properties: { scope: { type: "string", minLength: 1 } },
            },
            conformanceInput: undefined,
            normalizeInput: undefined,
          },
        ],
      },
      manifest: {
        ...source.manifest,
        workflows: source.manifest.workflows.filter((declared) => declared.type === workflow.type),
      },
    };

    expect(() => validateLoadedModules([changed])).toThrow("requires conformanceInput.scope");
    expect(() =>
      validateLoadedModules([
        {
          ...changed,
          controlPlane: {
            ...changed.controlPlane,
            workflows: [
              { ...changed.controlPlane.workflows[0]!, conformanceInput: { scope: "ci" } },
            ],
          },
        },
      ]),
    ).not.toThrow();
  });

  it("rejects missing providers and incompatible runtimes", async () => {
    const modules = await loadAgentModules(process.cwd());
    const source = modules[3]!;
    const missing = {
      ...source,
      runner: { ...source.runner, tools: [] },
    };
    expect(() => validateLoadedModules([missing])).toThrow("missing runner binding");
    const incompatible = {
      ...source,
      controlPlane: { ...source.controlPlane, compatiblePackVersions: "^9.0.0" },
      runner: { ...source.runner, compatiblePackVersions: "^9.0.0" },
      web: { ...source.web, compatiblePackVersions: "^9.0.0" },
    };
    expect(() => validateLoadedModules([incompatible])).toThrow("incompatible");
  });

  it("requires Fly control-plane and runner contracts to match exactly", async () => {
    const modules = await loadAgentModules(process.cwd());
    const source = modules[0]!;
    const [firstRunnerTool, ...rest] = source.runner.tools;
    if (!firstRunnerTool) throw new Error("Repository Analyst must declare a runner tool.");
    const mismatch = {
      ...source,
      runner: {
        ...source.runner,
        tools: [
          { ...firstRunnerTool, maxArtifactBytes: firstRunnerTool.maxArtifactBytes + 1 },
          ...rest,
        ],
      },
    };
    expect(() => validateLoadedModules([mismatch])).toThrow("runner contract does not match");
  });

  it("rejects action timeouts that exceed their runner publication budget", async () => {
    const modules = await loadAgentModules(process.cwd());
    const source = modules.find((module) => module.manifest.id === "complex-operator");
    if (!source) throw new Error("Complex Operator must be configured.");
    const actionIndex = source.controlPlane.tools.findIndex(
      (tool) => tool.id === "operator.action.execute",
    );
    const actionTool = source.controlPlane.tools[actionIndex];
    if (!actionTool?.action) throw new Error("Complex Operator must declare an action binding.");
    const tools = [...source.controlPlane.tools];
    tools[actionIndex] = {
      ...actionTool,
      action: { ...actionTool.action, timeoutMs: actionTool.timeoutMs + 1 },
    };

    expect(() =>
      validateLoadedModules([{ ...source, controlPlane: { ...source.controlPlane, tools } }]),
    ).toThrow("action timeout must fit within the tool timeout");
  });

  it("rejects invalid schemas and unsupported execution modes", async () => {
    const modules = await loadAgentModules(process.cwd());
    const source = modules[3]!;
    const [firstTool, ...rest] = source.controlPlane.tools;
    if (!firstTool) throw new Error("Complex Operator must declare a tool.");
    const invalidSchema = {
      ...source,
      controlPlane: {
        ...source.controlPlane,
        tools: [{ ...firstTool, inputSchema: { type: "unsupported" } }, ...rest],
      },
    };
    expect(() => validateLoadedModules([invalidSchema])).toThrow("supported JSON Schema");

    const invalidMode = {
      ...source,
      controlPlane: {
        ...source.controlPlane,
        tools: [{ ...firstTool, executionModes: ["teleport"] }, ...rest],
      },
    };
    expect(() => validateLoadedModules([invalidMode as typeof source])).toThrow(
      "unsupported execution mode",
    );
  });

  it("rejects unsafe execute bindings and undeclared action connections", async () => {
    const modules = await loadAgentModules(process.cwd());
    const source = modules[3]!;
    const executeTool = source.controlPlane.tools.find((tool) =>
      tool.executionModes.includes("execute"),
    );
    if (!executeTool) throw new Error("Complex Operator must declare an execute tool.");

    const missingAction = {
      ...source,
      controlPlane: {
        ...source.controlPlane,
        tools: source.controlPlane.tools.map((tool) =>
          tool.id === executeTool.id ? { ...tool, action: undefined } : tool,
        ),
      },
    };
    expect(() => validateLoadedModules([missingAction as typeof source])).toThrow(
      "execute mode lacks an action binding",
    );

    const undeclaredConnection = {
      ...source,
      controlPlane: {
        ...source.controlPlane,
        tools: source.controlPlane.tools.map((tool) =>
          tool.id === executeTool.id && tool.action
            ? { ...tool, action: { ...tool.action, connectionId: "missing.connection" } }
            : tool,
        ),
      },
    };
    expect(() => validateLoadedModules([undeclaredConnection as typeof source])).toThrow(
      "action connection is undeclared",
    );
  });

  it("names a package subpath that is absent from exports", () => {
    const root = temporaryRoot();
    const packageDirectory = resolve(root, "node_modules/example-pack");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(
      resolve(packageDirectory, "package.json"),
      JSON.stringify({ name: "example-pack", version: "1.0.0", exports: {} }),
    );

    expect(() =>
      resolveAgentModuleImportTarget(root, { package: "example-pack" }, "manifest"),
    ).toThrow("example-pack/manifest is not installed or does not expose the required subpath");
  });

  it("rejects a package that resolves only through a parent workspace", () => {
    const parent = temporaryRoot();
    const root = resolve(parent, "consumer");
    mkdirSync(root, { recursive: true });
    writeFileSync(resolve(root, "package.json"), '{"type":"module"}\n');
    const packageDirectory = resolve(parent, "node_modules/hoisted-pack");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(resolve(packageDirectory, "manifest.mjs"), "export const manifest = {};\n");
    writeFileSync(
      resolve(packageDirectory, "package.json"),
      JSON.stringify({
        name: "hoisted-pack",
        version: "1.0.0",
        exports: { "./manifest": "./manifest.mjs" },
      }),
    );

    expect(() =>
      resolveAgentModuleImportTarget(root, { package: "hoisted-pack" }, "manifest"),
    ).toThrow("install it in the consumer instead of relying on workspace hoisting");
  });

  it("rejects invalid declaration files in installed runtime subpaths", () => {
    const root = temporaryRoot();
    const packageDirectory = resolve(root, "node_modules/invalid-types-pack");
    mkdirSync(packageDirectory, { recursive: true });
    const exports = Object.fromEntries(
      ["manifest", "control-plane", "runner", "web"].map((subpath) => [
        `./${subpath}`,
        { types: `./${subpath}.d.ts`, default: `./${subpath}.mjs` },
      ]),
    );
    writeFileSync(
      resolve(packageDirectory, "package.json"),
      JSON.stringify({ name: "invalid-types-pack", version: "1.0.0", type: "module", exports }),
    );
    for (const subpath of ["manifest", "control-plane", "runner", "web"]) {
      writeFileSync(resolve(packageDirectory, `${subpath}.mjs`), "export const value = {};\n");
      writeFileSync(
        resolve(packageDirectory, `${subpath}.d.ts`),
        subpath === "runner"
          ? "export declare const runner: ;\n"
          : "export declare const value: {};\n",
      );
    }

    expect(() => validateInstalledPackageContract(root, { package: "invalid-types-pack" })).toThrow(
      "invalid-types-pack/runner declaration file is invalid",
    );
  });
});
