import { defineWorkbenchConfig } from "@operloom/agent-sdk";

export default defineWorkbenchConfig({
  runtimeApiVersion: 2,
  workbenchVersion: "2.0.0",
  modules: [
    {
      package: "@operloom/pack-document-review",
      source: "./examples/document-review",
      conformanceOnly: true,
    },
    { package: "@operloom/pack-operloom", source: "./agent-packs/operloom" },
    { package: "@operloom/pack-polymancer", source: "./agent-packs/polymancer" },
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
    {
      package: "@operloom/pack-resource-allocator",
      source: "./examples/resource-allocator",
      conformanceOnly: true,
    },
    {
      package: "@operloom/provider-operation-fixture",
      source: "./tests/fixtures/provider-operation-package",
      conformanceOnly: true,
    },
  ],
});
