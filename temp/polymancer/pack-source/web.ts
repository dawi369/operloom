import { defineWebModule } from "@operloom/agent-sdk/web";

export const web = defineWebModule({
  packId: "polymancer",
  runtimeVersion: "1.0.0",
  compatiblePackVersions: "^1.0.0",
  artifactRenderers: {},
  managedStateRenderers: {
    "polymancer.position": { kind: "generic_detail", version: 1 },
    "polymancer.account": { kind: "generic_detail", version: 1 },
    "polymancer.wallet": { kind: "generic_detail", version: 1 },
    "polymancer.activity": { kind: "generic_detail", version: 1 },
    "polymancer.market": { kind: "generic_detail", version: 1 },
    "polymancer.heartbeat": { kind: "generic_detail", version: 1 },
  },
});
