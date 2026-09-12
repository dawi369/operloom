import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("hosted Level 3 drill entrypoint", () => {
  it("boots through tsx and fails closed before touching hosted state", () => {
    const result = spawnSync("pnpm", ["exec", "tsx", "scripts/run-hosted-level3-drills.ts"], {
      cwd: resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        WORKBENCH_HOSTED_DRILL_MODE: "",
        GITHUB_SHA: "",
        HOSTED_WEB_ORIGIN: "",
        CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET: "",
      },
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "WORKBENCH_HOSTED_DRILL_MODE=true is required",
    );
  });
});
