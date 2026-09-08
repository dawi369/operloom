import { defineWebModule } from "@operloom/agent-sdk/web";

export const web = defineWebModule({
  packId: "baby-swordfish",
  runtimeVersion: "1.1.0",
  compatiblePackVersions: "^1.2.0",
  artifactRenderers: {},
  managedStateRenderers: {},
});
