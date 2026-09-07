import { defineControlPlaneModule } from "@operloom/agent-sdk/control-plane";

export const controlPlane = defineControlPlaneModule({
  packId: "external-agent-fixture",
  runtimeVersion: "1.0.0",
  compatiblePackVersions: "^1.0.0",
  tools: [],
  workflows: [],
  health: [],
  evals: [],
});
