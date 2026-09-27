import { afterEach, describe, expect, it, vi } from "vitest";

import {
  invokeFlyToolRunner,
  repoSnapshotSandboxContract,
  runnerMetadataFor,
  runnerEchoSandboxContract,
  urlInspectSandboxContract,
} from "./tool-runner";
import type { AgentIdentity, Env } from "./types";

const identity = {
  scope: {
    userId: "user-1",
    workspaceId: "workspace-1",
  },
  agentId: "agent-1",
} as AgentIdentity;

const env = {
  OPERLOOM_RUNNER_URL: "https://runner.example.test/workbench/tool-runners/invocations",
  OPERLOOM_RUNNER_SIGNING_SECRET: "runner-secret",
} as Env;

describe("tool runner sandbox contracts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("builds a compact url.inspect sandbox contract from policy constraints", () => {
    const sandbox = urlInspectSandboxContract({
      allowlist: ["Example.com", "*.example.org", ""],
      denylist: ["bad.example"],
      maxRuntimeMs: 1_000,
    });

    expect(sandbox).toEqual({
      lifecycle: {
        template: "url-inspect-v1",
        setup: "per_invocation",
        workspaceState: "none",
        filesystem: "ephemeral",
        artifactPromotion: "metadata_only",
      },
      network: {
        egress: "public_web",
        allowedSchemes: ["http", "https"],
        allowedHosts: ["example.com", "*.example.org"],
        deniedHosts: ["bad.example"],
        privateNetwork: "deny",
        enforcement: "control_plane_and_runner",
      },
      limits: {
        maxRuntimeMs: 1_000,
      },
    });
    expect(JSON.stringify(sandbox)).not.toMatch(/token|secret|prompt|message/i);
  });

  it("attaches sandbox metadata to runner metadata", () => {
    const sandbox = urlInspectSandboxContract();
    const runner = runnerMetadataFor(
      {
        toolName: "url.inspect",
        adapterVersion: "url-inspect-v1",
        supportedExecutionModes: ["dry_run"],
        transport: "fly",
      },
      "admin",
      "fly",
      sandbox,
    );

    expect(runner).toMatchObject({
      transport: "fly",
      adapterVersion: "url-inspect-v1",
      source: "admin",
      sandbox: {
        network: {
          privateNetwork: "deny",
        },
      },
    });
  });

  it("builds a no-egress repo.snapshot sandbox contract", () => {
    const sandbox = repoSnapshotSandboxContract({ maxRuntimeMs: 2_500 });

    expect(sandbox).toEqual({
      lifecycle: {
        template: "repo-snapshot-v1",
        setup: "per_invocation",
        workspaceState: "none",
        filesystem: "ephemeral",
        artifactPromotion: "metadata_only",
      },
      network: {
        egress: "none",
        allowedSchemes: [],
        allowedHosts: [],
        deniedHosts: ["*"],
        privateNetwork: "deny",
        enforcement: "control_plane_and_runner",
      },
      limits: {
        maxRuntimeMs: 2_500,
        maxStdoutBytes: 65536,
        maxStderrBytes: 16384,
        maxArtifactBytes: 131072,
      },
    });
    expect(JSON.stringify(sandbox)).not.toMatch(/token|secret|prompt|message/i);
  });

  it("builds a no-egress runner.echo sandbox contract without artifact promotion", () => {
    const sandbox = runnerEchoSandboxContract({ maxRuntimeMs: 1_250 });

    expect(sandbox).toEqual({
      lifecycle: {
        template: "runner-echo-v1",
        setup: "per_invocation",
        workspaceState: "none",
        filesystem: "ephemeral",
        artifactPromotion: "metadata_only",
      },
      network: {
        egress: "none",
        allowedSchemes: [],
        allowedHosts: [],
        deniedHosts: ["*"],
        privateNetwork: "deny",
        enforcement: "control_plane_and_runner",
      },
      limits: {
        maxRuntimeMs: 1_250,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        maxArtifactBytes: 0,
      },
    });
    expect(JSON.stringify(sandbox)).not.toMatch(/token|secret|prompt|command|path|url/i);
  });

  it("preserves typed Fly runner error codes in failed dispatch metrics", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            ok: false,
            error: {
              code: "runner_callback_signing_not_configured",
              message: "Workbench callback signing is not configured for the runner.",
              retryable: false,
              redacted: true,
            },
            metrics: {
              callback: { status: "completed" },
              transport: "fly",
            },
          },
          { status: 500 },
        ),
      ),
    );

    const result = await invokeFlyToolRunner(env, identity, {
      toolName: "runner.echo",
      runId: "run-1",
      workflowIntentId: "intent-1",
      scope: {
        userId: "user-1",
        workspaceId: "workspace-1",
      },
      agentId: "agent-1",
      execution: {
        mode: "dry_run",
        policy: "admin-conformance-runner-echo-v0",
      },
      input: {
        message: "runner echo ok",
      },
      runner: runnerMetadataFor(
        {
          toolName: "runner.echo",
          adapterVersion: "runner-echo-v1",
          supportedExecutionModes: ["dry_run"],
          transport: "fly",
        },
        "admin",
        "fly",
        runnerEchoSandboxContract(),
      ),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("runner dispatch unexpectedly succeeded");
    expect(result.error.code).toBe("runner_callback_signing_not_configured");
    expect(result.error.message).toBe(
      "Workbench callback signing is not configured for the runner.",
    );
    expect(result.metrics).toMatchObject({
      status: 500,
      code: "runner_callback_signing_not_configured",
      runnerCode: "runner_callback_signing_not_configured",
      callback: { status: "completed" },
      transport: "fly",
    });
  });
});
