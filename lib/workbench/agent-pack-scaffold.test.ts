import { describe, expect, it } from "vitest";

import {
  registerAgentPackSource,
  renderAgentPackIndex,
  renderAgentPackPrompt,
  renderAgentPackReadme,
  renderAgentPackTest,
  validateAgentPackScaffoldInput,
} from "./agent-pack-scaffold";

describe("Agent Pack scaffold", () => {
  it("renders a conservative Pack API v2 starter with matching prompt provenance", () => {
    const source = renderAgentPackIndex({ id: "trade-watcher", name: "Trade Watcher" });

    expect(source).toContain('id: "trade-watcher"');
    expect(source).toContain("externalMutation: false");
    expect(source).toContain('executionModes: ["dry_run"]');
    expect(source).toContain('minimumWorkbenchVersion: "0.5.0"');
    expect(source).toContain(JSON.stringify(renderAgentPackPrompt("Trade Watcher")));
  });

  it("rejects unsafe identifiers and empty names before touching the filesystem", () => {
    expect(() => validateAgentPackScaffoldInput({ id: "Trade Watcher", name: "Trade" })).toThrow(
      "lowercase kebab-case",
    );
    expect(() => validateAgentPackScaffoldInput({ id: "trade-watcher", name: "" })).toThrow(
      "name is required",
    );
  });

  it("adds one package entry to workbench config and rejects duplicate registration", () => {
    const registry = `export default defineWorkbenchConfig({\n  runtimeApiVersion: 1,\n  workbenchVersion: "0.5.0",\n  modules: [\n  ],\n});\n`;
    const updated = registerAgentPackSource(registry, "trade-watcher");

    expect(updated).toContain('package: "@operloom/pack-trade-watcher"');
    expect(updated).toContain('source: "./agent-packs/trade-watcher"');
    expect(() => registerAgentPackSource(updated, "trade-watcher")).toThrow("already configured");
  });

  it("renders a self-documenting package with focused runtime characterization", () => {
    const input = { id: "trade-watcher", name: "Trade Watcher" };

    expect(renderAgentPackReadme(input)).toContain(
      "pnpm workbench pack check --pack trade-watcher",
    );
    expect(renderAgentPackReadme(input)).toContain("Package boundaries");
    expect(renderAgentPackTest(input)).toContain('expect(manifest.id).toBe("trade-watcher")');
    expect(renderAgentPackTest(input)).toContain("health.check()");
    expect(renderAgentPackTest(input)).toContain("evaluation.run()");
  });
});

it("generates a hyphenated pack that passes the real developer validator", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const ts = await import("typescript");
  const { validateAgentPacksForDeveloperLoop } = await import("./agent-pack-dev-loop");
  const root = mkdtempSync(join(tmpdir(), "operloom-scaffold-"));
  const input = { id: "my-agent", name: "My Agent" };
  const source = renderAgentPackIndex(input);
  try {
    const folder = join(root, "agent-packs", input.id);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "index.ts"), source);
    writeFileSync(join(folder, "prompt.xml"), renderAgentPackPrompt(input.name));
    // Evaluate the actual generated module through the real SDK, not a mirrored fixture.
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText;
    const { createRequire } = await import("node:module");
    const module = { exports: {} as Record<string, unknown> };
    new Function("module", "exports", "require", compiled)(
      module,
      module.exports,
      createRequire(import.meta.url),
    );
    const result = validateAgentPacksForDeveloperLoop({
      packs: [module.exports.myAgentPack as import("../../agent-packs").LocalAgentPackManifest],
      rootDir: root,
    });
    expect(result.errors).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
