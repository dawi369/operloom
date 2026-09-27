import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { agentConformanceRegistry } from "../generated/agent-runtime/conformance";
import { loadAgentModules } from "./agent-pack-compiler";

type CommandResult = {
  command: string;
  durationMs: number;
  status: "passed" | "failed";
  guarantees: string[];
};

const run = (args: string[], guarantees: string[]): CommandResult => {
  const started = Date.now();
  const result = spawnSync("pnpm", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const command = `pnpm ${args.join(" ")}`;
  if (result.status !== 0) {
    throw Object.assign(new Error(`${command} failed.`), {
      commandResult: {
        command,
        durationMs: Date.now() - started,
        status: "failed",
        guarantees,
      } satisfies CommandResult,
    });
  }
  return {
    command,
    durationMs: Date.now() - started,
    status: "passed",
    guarantees,
  };
};

const main = async () => {
  const modules = await loadAgentModules(process.cwd());
  const results: CommandResult[] = [];
  let failure: unknown = null;
  try {
    results.push(run(["agent-packs:compile", "--check"], ["deterministic-registry"]));
    results.push(run(["agent-packs:validate"], ["pack-api-v2-snapshots"]));
    results.push(
      run(
        [
          "exec",
          "vitest",
          "run",
          "packages/agent-sdk/src/sdk.test.ts",
          "scripts/agent-pack-compiler.test.ts",
        ],
        [
          "schema-validation",
          "compatibility",
          "collision-detection",
          "connection-authorization",
          "mutation-disabled",
        ],
      ),
    );
    results.push(
      run(
        [
          "exec",
          "vitest",
          "run",
          "cloudflare/control-plane/src/approval-transitions.test.ts",
          "cloudflare/control-plane/src/run-control.test.ts",
          "cloudflare/control-plane/src/workflow-callbacks.test.ts",
          "cloudflare/control-plane/src/managed-state.test.ts",
          "cloudflare/control-plane/src/triggers.test.ts",
          "cloudflare/control-plane/src/trigger-webhook.test.ts",
        ],
        [
          "approval-denial-recovery",
          "cancellation-late-result-rejection",
          "linked-retry",
          "managed-state-cas",
          "schedule-and-webhook-triggers",
          "tenant-scoped-runtime-writes",
        ],
      ),
    );
    results.push(
      run(
        ["test:service-boundaries:agent-system"],
        [
          "generic-cloudflare-workflow",
          "signed-fly-runtime-tool",
          "runtime-metadata",
          "structured-artifact",
          "managed-state-cas",
        ],
      ),
    );
    // Test fixtures need prior runtime state and have dedicated suites (provider-operations).
    for (const item of modules.filter(
      (module) => !module.entry.source?.startsWith("./tests/fixtures/"),
    )) {
      const guarantees = agentConformanceRegistry
        .filter((row) => row.packId === item.manifest.id && row.required)
        .map((row) => row.id);
      results.push(run(["agent-packs:test", "--pack", item.manifest.id], guarantees));
    }
  } catch (error) {
    failure = error;
    const commandResult =
      error && typeof error === "object" && "commandResult" in error
        ? (error.commandResult as CommandResult)
        : null;
    if (commandResult) results.push(commandResult);
  }
  const covered = new Set(results.flatMap((result) => result.guarantees));
  const requiredGuarantees = agentConformanceRegistry
    .filter((row) => row.required)
    .map((row) => row.id);
  const requiredGuaranteeSet = new Set<string>(requiredGuarantees);
  const coveredRequiredGuarantees = requiredGuarantees.filter((id) => covered.has(id));
  const missing = requiredGuarantees.filter((id) => !covered.has(id));
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? null,
    status: !failure && missing.length === 0 ? "passed" : "failed",
    requiredGuarantees,
    coveredGuarantees: coveredRequiredGuarantees,
    supplementalGuarantees: [...covered]
      .filter((guarantee) => !requiredGuaranteeSet.has(guarantee))
      .sort(),
    missingGuarantees: missing,
    failureArtifacts: [
      "output/playwright",
      "output/sdk-consumer",
      "cloudflare/control-plane/.wrangler/logs",
    ],
    commands: results,
  };
  const outputDirectory = resolve(process.cwd(), "output/conformance");
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(
    resolve(outputDirectory, "agent-system.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    `Agent-system conformance ${report.status}: ${coveredRequiredGuarantees.length}/${requiredGuarantees.length} required guarantees covered.`,
  );
  if (failure) throw failure;
  if (missing.length) throw new Error(`Missing executable guarantees: ${missing.join(", ")}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
