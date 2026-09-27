import { defineWebModule } from "@operloom/agent-sdk/web";
export const web = defineWebModule({
  packId: "resource-allocator",
  runtimeVersion: "1.0.0",
  compatiblePackVersions: "^1.0.0",
  artifactRenderers: {},
  managedStateRenderers: {},
});
