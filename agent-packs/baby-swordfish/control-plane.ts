import { defineControlPlaneModule } from "@operloom/agent-sdk/control-plane";

export const controlPlane = defineControlPlaneModule({
  packId: "baby-swordfish",
  runtimeVersion: "1.1.0",
  compatiblePackVersions: "^1.2.0",
  tools: [],
  workflows: [],
  health: [
    {
      id: "parked.static",
      required: true,
      check: () => ({ ok: true, summary: "Swordfish remains packaged and parked." }),
    },
  ],
  evals: [
    {
      id: "runtime.overview.static",
      required: true,
      run: () => ({ ok: true, summary: "Parked Swordfish static contract compiled." }),
    },
  ],
});
