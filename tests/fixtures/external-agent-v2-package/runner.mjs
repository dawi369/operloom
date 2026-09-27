import { defineRunnerModule } from "@operloom/agent-sdk/runner";

export const runner = defineRunnerModule({
  packId: "external-agent-v2-fixture",
  runtimeVersion: "1.0.0",
  compatiblePackVersions: "^1.0.0",
  tools: [],
});
