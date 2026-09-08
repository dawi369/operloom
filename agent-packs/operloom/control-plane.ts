import { defineControlPlaneModule } from "@operloom/agent-sdk/control-plane";

export const controlPlane = defineControlPlaneModule({
  packId: "operloom",
  runtimeVersion: "1.0.0",
  compatiblePackVersions: "^1.0.0",
  tools: [],
  workflows: [],
  health: [],
  evals: [
    {
      id: "general.static",
      required: true,
      run: () => ({
        ok: true,
        summary: "Operloom conversational default is available without integrations.",
      }),
    },
  ],
});
