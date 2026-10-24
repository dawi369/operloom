import { describe, expect, it } from "vitest";

import {
  loadWorkerEnvironment,
  parseWorkerEnvironment,
  renderWorkerEnvironment,
  validateWorkerEnvironmentAgainstTargets,
} from "./worker-environment";

describe("worker-only environments", () => {
  it("accepts the tracked staging manifest and keeps it apart from the full targets", () => {
    const staging = loadWorkerEnvironment("staging");
    expect(staging.cloudflare.workerName).toBe("operloom-staging-control-plane");
    expect(validateWorkerEnvironmentAgainstTargets(staging)).toEqual([]);
  });

  it("renders a secret-free Worker config with inline runner and WorkOS verification", () => {
    const rendered = renderWorkerEnvironment(loadWorkerEnvironment("staging"), {
      releaseSha: "a".repeat(40),
    });
    const vars = rendered.wrangler.vars;
    expect(vars.OPERLOOM_RUNNER_TRANSPORT).toBe("inline");
    expect(vars.OPERLOOM_ENVIRONMENT).toBe("staging");
    expect(vars.OPERLOOM_WORKOS_ALLOWED_CLIENT_IDS.split(",")).toHaveLength(2);
    expect(vars.OPERLOOM_RELEASE_SHA).toBe("a".repeat(40));
    expect(JSON.stringify(rendered.wrangler)).not.toMatch(/sk-|secret_|API_KEY/i);
    expect(rendered.wrangler.d1_databases[0]!.migrations_dir).toContain("control-plane/migrations");
    expect(rendered.wrangler.observability).toEqual({
      enabled: true,
      head_sampling_rate: 1,
      logs: { invocation_logs: true },
    });
  });

  it("rejects manifests that collide with full targets or point at http origins", () => {
    const staging = loadWorkerEnvironment("staging");
    expect(() => parseWorkerEnvironment({ ...staging, name: "acceptance" })).toThrow(
      /collides with a full environment target/,
    );
    expect(() =>
      parseWorkerEnvironment({
        ...staging,
        cloudflare: { ...staging.cloudflare, origin: "http://worker.test" },
      }),
    ).toThrow(/cloudflare.origin must use https/);
    expect(() =>
      parseWorkerEnvironment({ ...staging, workos: { ...staging.workos, allowedClientIds: [] } }),
    ).toThrow(/at least one id/);
    expect(
      validateWorkerEnvironmentAgainstTargets({
        ...staging,
        cloudflare: { ...staging.cloudflare, workerName: "operloom-acceptance-control-plane" },
      }),
    ).toEqual(["cloudflare.workerName is shared with acceptance"]);
  });
});
