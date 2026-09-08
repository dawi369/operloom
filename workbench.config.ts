import { defineWorkbenchConfig } from "@operloom/agent-sdk";

export default defineWorkbenchConfig({
  runtimeApiVersion: 1,
  workbenchVersion: "1.0.0",
  modules: [
    { package: "@operloom/pack-operloom", source: "./agent-packs/operloom" },
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
