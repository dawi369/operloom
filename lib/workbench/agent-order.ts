import { agentManifestRegistry } from "../../generated/agent-runtime/manifests";
import type { AgentSummary } from "./workbench-types";

// Keep the picker aligned with the configured catalog, independent of selection.
const packOrder = new Map(Object.keys(agentManifestRegistry).map((id, index) => [id, index]));
const rank = (agent: AgentSummary) =>
  packOrder.get(agent.behavior.pack?.id ?? "") ?? Number.MAX_SAFE_INTEGER;

export const sortWorkbenchAgents = (agents: AgentSummary[]) =>
  [...agents].sort((left, right) => {
    if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
    if (left.status !== right.status) return left.status === "active" ? -1 : 1;
    return rank(left) - rank(right) || left.name.localeCompare(right.name);
  });
