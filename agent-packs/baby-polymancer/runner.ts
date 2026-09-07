import { defineRunnerModule } from "@operloom/agent-sdk/runner";

export const runner = defineRunnerModule({
  packId: "baby-polymancer",
  runtimeVersion: "1.1.0",
  compatiblePackVersions: "^1.1.0",
  tools: [],
});
