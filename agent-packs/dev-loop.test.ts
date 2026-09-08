import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { localAgentPacks, validateLocalAgentPack, type LocalAgentPackManifest } from ".";
import {
  inspectAgentPackForDeveloperLoop,
  smokeAgentPackForDeveloperLoop,
  validateAgentPacksForDeveloperLoop,
} from "../lib/workbench/agent-pack-dev-loop";

const rootDir = process.cwd();
const repoAnalystPack = localAgentPacks.find((pack) => pack.id === "repo-analyst")!;

const writePackFiles = (
  root: string,
  pack: LocalAgentPackManifest,
  input?: { prompt?: string },
) => {
  mkdirSync(path.join(root, pack.folderPath), { recursive: true });
  writeFileSync(path.join(root, pack.codePath), "export {};\n");
  writeFileSync(path.join(root, pack.promptPath), input?.prompt ?? pack.prompt);
};

const withPack = (input: Partial<LocalAgentPackManifest>): LocalAgentPackManifest => {
  const id = input.id ?? "test-pack";
  return {
    ...repoAnalystPack,
    id,
    templateId: `pack-${id}`,
    folderPath: "agent-packs/test-pack",
    codePath: "agent-packs/test-pack/index.ts",
    promptPath: "agent-packs/test-pack/prompt.xml",
    ...input,
  } as LocalAgentPackManifest;
};

describe("agent pack developer loop", () => {
  it("validates checked-in packs", () => {
    const result = validateAgentPacksForDeveloperLoop({ rootDir });

    expect(result.ok).toBe(true);
    expect(result.packCount).toBe(localAgentPacks.length);
    expect(result.errors).toEqual([]);
    expect(localAgentPacks.every((pack) => pack.apiVersion === 2)).toBe(true);
    expect(() => JSON.stringify(localAgentPacks)).not.toThrow();
  });

  it("validates executable v2 extension descriptors with default authority disabled", () => {
    const pack = withPack({
      managedState: [
        {
          namespace: "example.watchlist",
          schemaVersion: 1,
          description: "Example namespaced state declaration.",
          recordKinds: ["watch"],
          views: [{ id: "watchlist", title: "Watchlist", recordKind: "watch" }],
        },
      ],
      triggers: [
        {
          id: "watch.poll",
          kind: "monitor",
          description: "A declarative monitor with no runtime authority.",
          workflowType: "repo.readiness_report",
          enabledByDefault: false,
          intervalSeconds: 300,
        },
      ],
    });

    expect(() => validateLocalAgentPack(pack)).not.toThrow();
    const inspection = inspectAgentPackForDeveloperLoop(pack.id, {
      rootDir,
      packs: [pack],
    });
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) throw new Error("expected inspection success");
    expect(inspection.pack.managedState[0]?.namespace).toBe("example.watchlist");
    expect(inspection.pack.triggers[0]).toMatchObject({
      id: "watch.poll",
      enabledByDefault: false,
    });
    expect(inspection.validation.warnings).toEqual([]);
  });

  it("rejects invalid v2 references, limits, and executable manifest values", () => {
    expect(() =>
      validateLocalAgentPack(
        withPack({
          healthChecks: [
            {
              id: "missing.binding",
              target: { kind: "tool", id: "missing.tool" },
              description: "Missing target.",
              required: true,
            },
          ],
        }),
      ),
    ).toThrow("target is undeclared");

    expect(() =>
      validateLocalAgentPack(
        withPack({
          resourceLimits: { ...repoAnalystPack.resourceLimits, maxConcurrentRuns: 0 },
        }),
      ),
    ).toThrow("must be a positive integer");

    expect(() =>
      validateLocalAgentPack(
        withPack({
          compatibility: {
            ...repoAnalystPack.compatibility,
            probe: () => "not serializable",
          } as LocalAgentPackManifest["compatibility"],
        }),
      ),
    ).toThrow("JSON-serializable");
  });

  it("rejects duplicate ids and template ids", () => {
    const duplicate = {
      ...repoAnalystPack,
      id: localAgentPacks[1].id,
      templateId: localAgentPacks[1].templateId,
    } as LocalAgentPackManifest;

    const result = validateAgentPacksForDeveloperLoop({
      rootDir,
      packs: [localAgentPacks[1], duplicate],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((item) => item.message).join("\n")).toContain("duplicate");
  });

  it("accepts two or four welcome starters and rejects uneven grids", () => {
    const starters = repoAnalystPack.ui.welcome.starters;
    expect(() =>
      validateLocalAgentPack(
        withPack({
          ui: {
            ...repoAnalystPack.ui,
            welcome: { ...repoAnalystPack.ui.welcome, starters: starters.slice(0, 2) },
          },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateLocalAgentPack(
        withPack({
          ui: {
            ...repoAnalystPack.ui,
            welcome: { ...repoAnalystPack.ui.welcome, starters: starters.slice(0, 3) },
          },
        }),
      ),
    ).toThrow("exactly two or four");
  });

  it("rejects missing prompt files and prompt mismatch", () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "agent-pack-dev-loop-"));
    const missingPromptPack = withPack({});
    mkdirSync(path.join(tempRoot, missingPromptPack.folderPath), { recursive: true });
    writeFileSync(path.join(tempRoot, missingPromptPack.codePath), "export {};\n");

    const missingPrompt = validateAgentPacksForDeveloperLoop({
      rootDir: tempRoot,
      packs: [missingPromptPack],
    });
    expect(missingPrompt.ok).toBe(false);
    expect(
      missingPrompt.errors.some((item) => item.message.includes("promptPath does not exist")),
    ).toBe(true);

    const mismatchPack = withPack({ id: "mismatch-pack", templateId: "pack-mismatch" });
    const mismatchRoot = mkdtempSync(path.join(tmpdir(), "agent-pack-dev-loop-"));
    writePackFiles(mismatchRoot, mismatchPack, { prompt: "<identity>Different</identity>" });
    const mismatch = validateAgentPacksForDeveloperLoop({
      rootDir: mismatchRoot,
      packs: [mismatchPack],
    });

    expect(mismatch.ok).toBe(false);
    expect(mismatch.errors.some((item) => item.message.includes("prompt.xml must match"))).toBe(
      true,
    );
  });

  it("rejects malformed tools, missing smoke scenarios, secret packs, and unsafe execute mode", () => {
    const unsafePack = withPack({
      tools: [
        {
          ...repoAnalystPack.tools[0],
          id: "bad tool id",
          executionModes: ["execute"],
        },
      ],
      risk: {
        ...repoAnalystPack.risk,
        externalMutation: false,
        requiresSecrets: true,
        productionGate: "none",
      },
      smokeScenarios: [],
    });
    const tempRoot = mkdtempSync(path.join(tmpdir(), "agent-pack-dev-loop-"));
    writePackFiles(tempRoot, unsafePack);

    const result = validateAgentPacksForDeveloperLoop({ rootDir: tempRoot, packs: [unsafePack] });
    const messages = result.errors.map((item) => item.message).join("\n");

    expect(result.ok).toBe(false);
    expect(messages).toContain("cannot require secrets");
    expect(messages).toContain("cannot declare execute without externalMutation");
    expect(messages).toContain("smokeScenarios must include");
    expect(messages).toContain("tool id bad tool id is malformed");
  });

  it("inspects runtime bindings and flags missing bindings without throwing", () => {
    const pack = withPack({
      tools: [
        {
          ...repoAnalystPack.tools[0],
          id: "missing.tool",
        },
      ],
      workflows: [
        {
          type: "missing.workflow",
          engine: "langgraph",
          status: "declared",
          userInvocable: true,
          description: "Missing route binding for test.",
        },
      ],
    });
    const tempRoot = mkdtempSync(path.join(tmpdir(), "agent-pack-dev-loop-"));
    writePackFiles(tempRoot, pack);

    const result = inspectAgentPackForDeveloperLoop(pack.id, {
      rootDir: tempRoot,
      packs: [pack],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected inspection success");
    expect(result.tools[0]).toMatchObject({ id: "missing.tool", registered: false });
    expect(result.workflows[0]).toMatchObject({ type: "missing.workflow", registered: false });
    expect(result.validation.warnings).not.toEqual([]);
  });

  it("smokes checked-in packs through template and snapshot mapping", () => {
    const result = smokeAgentPackForDeveloperLoop("baby-polymancer", { rootDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected smoke success");
    expect(result.templateId).toBe("pack-baby-polymancer");
    expect(result.templateMapped).toBe(true);
    expect(result.snapshotMapped).toBe(true);
    expect(result.nextCommands).toContain("pnpm smoke:polymarket-readonly");
  });
});
