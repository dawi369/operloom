import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 2,
    exclude: [...configDefaults.exclude, "tests/e2e/**", "output/**", "apps/mobile/**"],
  },
});
