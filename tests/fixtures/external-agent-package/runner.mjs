import { defineRunnerModule } from "@operloom/agent-sdk/runner";

export const runner = defineRunnerModule({
  packId: "external-agent-fixture",
  runtimeVersion: "1.0.0",
  compatiblePackVersions: "^1.0.0",
  tools: [],
});
