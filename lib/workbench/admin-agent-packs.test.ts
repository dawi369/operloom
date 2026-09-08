import { describe, expect, it } from "vitest";

import { resolveAdminAgentPackState } from "./admin-agent-packs";
import type { AgentBehaviorTemplate, AgentSummary } from "./workbench-types";

const template = {
  id: "pack-repo-analyst",
  name: "Repository Analyst",
  description: "Repository analysis.",
  profile: "analyst",
  version: "1.0.0",
  format: "xml",
  pack: {
    id: "repo-analyst",
    tools: [],
    workflows: [],
    ui: {},
    risk: {},
    context: [],
    smokeScenarios: [],
    capabilityLevel: "single_agent_app",
    folderPath: "",
    codePath: "",
    promptPath: "",
  },
  prompt: "<identity>Repository Analyst</identity>",
} satisfies AgentBehaviorTemplate;

const agent = (id: string, version: string): AgentSummary => ({
  id,
  name: "Repository Analyst",
  description: null,
  status: "active",
  profile: "analyst",
  runtime: { provider: "openrouter", model: "test", temperature: 0, maxTokens: 1, source: "agent" },
  behavior: {
    profile: "analyst",
    source: "template-snapshot",
    version,
    instructionId: "test",
    pack: template.pack,
    authoring: { kind: "local_agent_pack", packId: "repo-analyst", packVersion: version },
  },
  isDefault: false,
  isActive: false,
});

describe("Admin agent pack state", () => {
  it("prefers the selected instance when multiple agents use the installed pack version", () => {
    const first = agent("workspace-default", "1.0.0");
    const selected = agent("local-development", "1.0.0");
    const state = resolveAdminAgentPackState(template, [first, selected], selected.id);
    expect(state?.state).toBe("current");
    expect(state?.currentVersionAgent?.id).toBe(selected.id);
    expect(resolveAdminAgentPackState(template, [first, agent("old", "0.9.0")], "old")?.state).toBe(
      "ready",
    );
  });

  it("distinguishes current, ready, outdated, and uninstantiated packs", () => {
    expect(
      resolveAdminAgentPackState(template, [agent("current", "1.0.0")], "current")?.state,
    ).toBe("current");
    expect(resolveAdminAgentPackState(template, [agent("current", "1.0.0")], "other")?.state).toBe(
      "ready",
    );
    expect(resolveAdminAgentPackState(template, [agent("old", "0.9.0")], "old")?.state).toBe(
      "update_available",
    );
    expect(resolveAdminAgentPackState(template, [], null)?.state).toBe("not_instantiated");
  });
});
