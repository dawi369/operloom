import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const suites = [
  {
    command: ["workbench-client:contract", "--check"],
    guarantees: ["tracked-public-contract"],
  },
  {
    command: ["workbench-client:verify"],
    guarantees: ["packed-vite-consumer", "no-workspace-resolution"],
  },
  {
    command: [
      "exec",
      "vitest",
      "run",
      "packages/workbench-client/src/client.test.ts",
      "packages/workbench-client/src/realtime.test.ts",
      "lib/workbench/mobile-access-token.test.ts",
      "lib/workbench/mobile-api-parity.test.ts",
      "lib/workbench/client-cors.test.ts",
    ],
    guarantees: [
      "cookie-bearer-parity",
      "authoritative-bearer",
      "tenant-derived-identity",
      "typed-resources",
      "resumable-events",
      "idempotent-turns",
      "configured-cors",
    ],
  },
] as const;

const results: Array<{
  command: string;
  durationMs: number;
  status: "passed" | "failed";
  guarantees: readonly string[];
}> = [];
let failed = false;
for (const suite of suites) {
  const started = Date.now();
  const result = spawnSync("pnpm", suite.command, { stdio: "inherit", env: process.env });
  results.push({
    command: `pnpm ${suite.command.join(" ")}`,
    durationMs: Date.now() - started,
    status: result.status === 0 ? "passed" : "failed",
    guarantees: suite.guarantees,
  });
  if (result.status !== 0) {
    failed = true;
    break;
  }
}
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  commit: process.env.GITHUB_SHA ?? null,
  status: failed ? "failed" : "passed",
  guarantees: results.flatMap((result) => result.guarantees),
  commands: results,
  failureArtifacts: ["output/workbench-client-consumer", "output/conformance/client.json"],
};
const directory = resolve(process.cwd(), "output/conformance");
mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, "client.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Client conformance ${report.status}.`);
if (failed) process.exitCode = 1;
