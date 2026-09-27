import { defineWebModule } from "@operloom/agent-sdk/web";
export const web = defineWebModule({
  packId: "resource-allocator",
  runtimeVersion: "1.0.0",
  compatiblePackVersions: "^1.0.0",
  artifactRenderers: {},
  managedStateRenderers: {
    "capacity.pool": { kind: "generic_detail", version: 1 },
    "capacity.request": { kind: "generic_detail", version: 1 },
    "capacity.monitor.cursor": { kind: "generic_detail", version: 1 },
  },
});
