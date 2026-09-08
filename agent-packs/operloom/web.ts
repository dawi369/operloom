import { defineWebModule } from "@operloom/agent-sdk/web";

export const web = defineWebModule({
  packId: "operloom",
  runtimeVersion: "1.0.0",
  compatiblePackVersions: "^1.0.0",
  artifactRenderers: {},
  managedStateRenderers: {},
});
