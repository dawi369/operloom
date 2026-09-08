import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  loadLocalAgentPacks,
  localAgentPacks,
  validateLocalAgentPacks,
  type LocalAgentPackManifest,
} from "../../../agent-packs";
import {
  agentBehaviorTemplates,
  createAgentBehaviorSnapshot,
  type AgentBehaviorTemplate,
} from "./agent-behavior-templates";

const promptFileByTemplateId = {
  "assistant-general": "assistant-general.xml",
  "assistant-analyst": "assistant-analyst.xml",
  "assistant-operator": "assistant-operator.xml",
  "assistant-integrator": "assistant-integrator.xml",
} as const;

const readPromptDoc = (fileName: string) =>
  readFileSync(new URL(`../../../docs/prompts/${fileName}`, import.meta.url), "utf8").trim();

const readPackPromptDoc = (fileName: string) =>
  readFileSync(new URL(`../../../${fileName}`, import.meta.url), "utf8").trim();

const pokeSpecificFacts =
  /Poke|Interaction Company|Palo Alto|Spark Capital|General Catalyst|Bouncer|Recipes|Apple Messages|film\.poke\.com|poke\.com/i;

describe("agent behavior authoring metadata", () => {
  it("starts with a general Operloom pack without specialist or external tools", () => {
    expect(localAgentPacks[0].id).toBe("operloom");
    expect(createAgentBehaviorSnapshot("default")).toMatchObject({
      templateId: "pack-operloom",
      pack: { id: "operloom", tools: [], workflows: [], triggers: [] },
    });
    expect(createAgentBehaviorSnapshot("analyst").templateId).toBe("assistant-analyst");
    expect(createAgentBehaviorSnapshot("default", "assistant-general").templateId).toBe(
      "assistant-general",
    );
  });

  it("marks built-in templates as non-editable XML snapshots", () => {
    expect(agentBehaviorTemplates).not.toHaveLength(0);
    for (const template of agentBehaviorTemplates.filter(
      (item) => item.authoring.kind === "built_in_template",
    )) {
      expect(template.version).toBe("2026-06-18");
      expect(template.authoring).toEqual({
        kind: "built_in_template",
        format: "xml",
        source: "cloudflare-control-plane",
        editable: false,
        snapshotOnCreate: true,
      });
    }
  });

  it("maps local agent packs into non-editable XML templates", () => {
    expect(localAgentPacks).not.toHaveLength(0);
    expect(loadLocalAgentPacks()).toHaveLength(localAgentPacks.length);

    for (const pack of localAgentPacks) {
      const template = agentBehaviorTemplates.find((item) => item.id === pack.templateId);
      expect(template).toMatchObject({
        id: pack.templateId,
        name: pack.name,
        profile: pack.profile,
        version: pack.version,
        format: "xml",
        authoring: {
          kind: "local_agent_pack",
          source: "agent-pack",
          packId: pack.id,
          packVersion: pack.version,
          folderPath: pack.folderPath,
          codePath: pack.codePath,
          promptPath: pack.promptPath,
          snapshotOnCreate: true,
        },
        pack: {
          id: pack.id,
          capabilityLevel: pack.capabilityLevel,
          folderPath: pack.folderPath,
          codePath: pack.codePath,
          promptPath: pack.promptPath,
          tools: pack.tools.map((tool) => ({ ...tool, executionModes: [...tool.executionModes] })),
          workflows: pack.workflows.map((workflow) => ({ ...workflow })),
          ui: { ...pack.ui, inspectorSections: [...pack.ui.inspectorSections] },
          risk: { ...pack.risk },
        },
      });
    }
  });

  it("validates local pack id uniqueness and risk/tool consistency", () => {
    const firstPack = localAgentPacks.find((pack) => pack.id === "repo-analyst")!;
    const duplicateTemplatePack = {
      ...firstPack,
      id: `${firstPack.id}-copy`,
      prompt: firstPack.prompt,
    } as LocalAgentPackManifest;
    expect(() => validateLocalAgentPacks([firstPack, duplicateTemplatePack])).toThrow(
      /templateId .* duplicate/,
    );

    const executeWithoutMutation = {
      ...firstPack,
      id: "unsafe-pack",
      templateId: "pack-unsafe-pack",
      tools: [
        {
          ...firstPack.tools[0],
          executionModes: ["execute"],
        },
      ],
      risk: {
        ...firstPack.risk,
        externalMutation: false,
        productionGate: "none",
      },
    } as LocalAgentPackManifest;
    expect(() => validateLocalAgentPacks([executeWithoutMutation])).toThrow(
      /cannot declare execute without externalMutation/,
    );

    const secretRequiringPack = {
      ...firstPack,
      id: "secret-pack",
      templateId: "pack-secret-pack",
      risk: {
        ...firstPack.risk,
        requiresSecrets: true,
      },
    } as LocalAgentPackManifest;
    expect(() => validateLocalAgentPacks([secretRequiringPack])).toThrow(/cannot require secrets/);
  });

  it("registers Baby Polymancer as a single-agent app seed", () => {
    const template = agentBehaviorTemplates.find((item) => item.id === "pack-baby-polymancer") as
      | AgentBehaviorTemplate
      | undefined;
    expect(template).toMatchObject({
      id: "pack-baby-polymancer",
      profile: "analyst",
      pack: {
        id: "baby-polymancer",
        capabilityLevel: "single_agent_app",
        risk: {
          financialData: true,
          externalMutation: false,
          requiresSecrets: false,
        },
      },
    });
    expect(template?.pack?.tools.map((tool) => tool.id)).toEqual([
      "polymarket.market.search",
      "polymarket.market.snapshot",
      "polymarket.orderbook.snapshot",
    ]);
    expect(template?.pack?.workflows).toEqual([
      expect.objectContaining({
        type: "polymancer.market_research",
        engine: "cloudflare",
        status: "declared",
      }),
    ]);
    expect(template?.prompt).toContain("Read-only market analysis only.");
    expect(template?.prompt).toContain("Do not place orders");
  });

  it("registers Baby Swordfish as a single-agent app seed", () => {
    const template = agentBehaviorTemplates.find((item) => item.id === "pack-baby-swordfish") as
      | AgentBehaviorTemplate
      | undefined;
    expect(template).toMatchObject({
      id: "pack-baby-swordfish",
      profile: "analyst",
      pack: {
        id: "baby-swordfish",
        capabilityLevel: "single_agent_app",
        risk: {
          financialData: true,
          externalMutation: false,
          requiresSecrets: false,
        },
      },
    });
    expect(template?.pack?.tools).toEqual([]);
    expect(template?.pack?.workflows).toEqual([]);
    expect(template?.prompt).toContain("parked reference agent");
  });

  it("copies authoring metadata into behavior snapshots", () => {
    const snapshot = createAgentBehaviorSnapshot("operator", "assistant-operator");

    expect(snapshot).toMatchObject({
      templateId: "assistant-operator",
      version: "2026-06-18",
      source: "template-snapshot",
      format: "xml",
      authoring: {
        kind: "built_in_template",
        source: "cloudflare-control-plane",
        snapshotOnCreate: true,
      },
    });
    expect(snapshot.prompt).toContain("<identity>");
  });

  it("keeps runtime templates aligned with checked-in prompt docs", () => {
    for (const [templateId, fileName] of Object.entries(promptFileByTemplateId)) {
      const template = agentBehaviorTemplates.find((item) => item.id === templateId);
      expect(template?.prompt.trim()).toBe(readPromptDoc(fileName));
    }
  });

  it("keeps local agent packs aligned with checked-in pack prompt docs", () => {
    for (const pack of localAgentPacks) {
      const template = agentBehaviorTemplates.find((item) => item.id === pack.templateId);
      expect(template?.prompt.trim()).toBe(readPackPromptDoc(pack.promptPath));
    }
  });

  it("keeps built-in prompts generic and free of Poke-specific product facts", () => {
    for (const template of agentBehaviorTemplates) {
      expect(template.prompt).not.toMatch(pokeSpecificFacts);
    }
  });
});
