import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("delegated graph startup", () => {
  it.each([undefined, "", "   "])(
    "loads without an optional model override (%s)",
    async (model) => {
      vi.stubEnv("OPENROUTER_API_KEY", "fixture-not-a-real-provider-key");
      vi.stubEnv("OPENROUTER_MODEL", model);
      const { graph } = await import("./agent");
      expect(typeof graph.invoke).toBe("function");
    },
  );
});
