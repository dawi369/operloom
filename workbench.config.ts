import { defineWorkbenchConfig } from "@operloom/agent-sdk";

export default defineWorkbenchConfig({
  runtimeApiVersion: 1,
  workbenchVersion: "0.5.1",
  modules: [
    {
      package: "@operloom/pack-repo-analyst",
      source: "./agent-packs/repo-analyst",
    },
    {
      package: "@operloom/pack-baby-polymancer",
      source: "./agent-packs/baby-polymancer",
    },
    {
      package: "@operloom/pack-baby-swordfish",
      source: "./agent-packs/baby-swordfish",
    },
    {
      package: "@operloom/pack-complex-operator",
      source: "./examples/complex-operator",
      conformanceOnly: true,
    },
  ],
});
