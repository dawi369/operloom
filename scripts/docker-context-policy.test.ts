import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerIgnore = readFileSync(new URL("../.dockerignore", import.meta.url), "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

const requiredExclusions = [
  ".assistant-mk1",
  ".vercel",
  ".playwright-cli",
  ".omm",
  "apps/mobile/.expo",
  "apps/mobile/ios",
  "apps/mobile/android",
  "output",
  "**/output",
  "coverage",
  "packages/*/dist",
  "agent-packs/*/dist",
  "examples/*/dist",
  "cloudflare/control-plane/.dev.vars",
  "cloudflare/control-plane/.wrangler",
] as const;

describe("Docker build context policy", () => {
  it("excludes local credentials, state, and generated release artifacts", () => {
    expect(dockerIgnore).toEqual(expect.arrayContaining([...requiredExclusions]));
  });

  it("keeps the public environment template available", () => {
    expect(dockerIgnore).toContain("!.env.example");
  });

  it("builds runtime-neutral workspace dependencies inside the image", () => {
    const dockerfile = readFileSync(new URL("../Dockerfile.runner", import.meta.url), "utf8");
    expect(dockerfile).toContain("COPY packages/observability/package.json");
    expect(dockerfile).toContain("RUN pnpm observability:build && pnpm agent-sdk:build");
    expect(dockerfile).toContain("/app/packages/observability/dist");
  });
});
