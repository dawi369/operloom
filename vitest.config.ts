import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // Mirrors tsconfig `paths` so component tests can import through `@/`.
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    maxWorkers: 2,
    exclude: [...configDefaults.exclude, "tests/e2e/**", "output/**", "apps/mobile/**"],
  },
});
