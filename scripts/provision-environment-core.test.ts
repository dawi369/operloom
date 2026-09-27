import { describe, expect, it } from "vitest";

import {
  describeProvisionCommandFailure,
  provisionResourceExists,
} from "./provision-environment-core";

describe("environment provisioning helpers", () => {
  it("recognizes exact provider resources without prefix collisions", () => {
    expect(
      provisionResourceExists(
        "cloudflare-d1",
        '[{"name":"operloom_acceptance"}]',
        "operloom_acceptance",
      ),
    ).toBe(true);
    expect(
      provisionResourceExists(
        "cloudflare-queue",
        "operloom-production-control-plane-notifications\n",
        "operloom-production-control-plane-notifications",
      ),
    ).toBe(true);
    expect(
      provisionResourceExists(
        "cloudflare-r2",
        "name: operloom-acceptance-artifacts-old\n",
        "operloom-acceptance-artifacts",
      ),
    ).toBe(false);
    expect(
      provisionResourceExists(
        "fly-app",
        '[{"Name":"operloom-acceptance-runner"}]',
        "operloom-acceptance-runner",
      ),
    ).toBe(true);
    expect(
      provisionResourceExists(
        "vercel-project",
        "  operloom-acceptance   https://example.invalid\n",
        "operloom-acceptance",
      ),
    ).toBe(true);
  });

  it("keeps provider failures bounded and actionable", () => {
    const message = describeProvisionCommandFailure({
      command: "vercel",
      args: ["project", "add", "operloom-acceptance", "--non-interactive"],
      status: 1,
      stdout: "",
      stderr: `unsupported option ${"x".repeat(600)}`,
    });
    expect(message).toContain("vercel project add operloom-acceptance --non-interactive");
    expect(message.length).toBeLessThan(600);
  });
});
