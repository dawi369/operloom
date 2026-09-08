import { expect, it } from "vitest";
import { sortWorkbenchAgents } from "./agent-order";
import type { AgentSummary } from "./workbench-types";

it("keeps configured pack order after switching agents or renaming instances", () => {
  const agents = ["baby-swordfish", "baby-polymancer", "repo-analyst", "operloom"].map(
    (id) =>
      ({
        id,
        name: id,
        isDefault: id === "operloom",
        isActive: id === "baby-swordfish",
        status: "active",
        behavior: { pack: { id } },
      }) as AgentSummary,
  );
  const originalOrder = agents.map((agent) => agent.id);
  expect(sortWorkbenchAgents(agents).map((agent) => agent.id)).toEqual([
    "operloom",
    "repo-analyst",
    "baby-polymancer",
    "baby-swordfish",
  ]);
  expect(agents.map((agent) => agent.id)).toEqual(originalOrder);
});
