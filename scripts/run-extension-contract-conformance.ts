import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { compileAgentPacks } from "./agent-pack-compiler";
import { runAgentPackConformance } from "./test-agent-pack";

type Evidence = {
  id: string;
  status: "passed" | "failed";
  durationMs: number;
  summary: string;
};

const root = process.cwd();
const output = resolve(root, "output/extension-contract");
const consumer = resolve(output, "consumer");
const reportPath = resolve(root, "output/conformance/extension-contract.json");
const evidence: Evidence[] = [];

const command = (
  id: string,
  executable: string,
  args: string[],
  cwd: string,
  options: { print?: boolean } = {},
) => {
  const started = Date.now();
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (options.print !== false && result.stdout) process.stdout.write(result.stdout);
  if (options.print !== false && result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    evidence.push({
      id,
      status: "failed",
      durationMs: Date.now() - started,
      summary: `${executable} ${args.join(" ")} failed.`,
    });
    throw new Error(`${id} failed with exit code ${result.status ?? "unknown"}.`);
  }
  evidence.push({
    id,
    status: "passed",
    durationMs: Date.now() - started,
    summary: `${executable} ${args.join(" ")} passed.`,
  });
  return result.stdout;
};

const archive = (prefix: string) => {
  const file = readdirSync(output).find(
    (candidate) => candidate.startsWith(prefix) && candidate.endsWith(".tgz"),
  );
  if (!file) throw new Error(`${prefix} archive was not produced.`);
  return resolve(output, file);
};

const writeReport = (failure?: unknown) => {
  mkdirSync(resolve(root, "output/conformance"), { recursive: true });
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? null,
    command: "pnpm conformance:extension-contract",
    status: failure ? "failed" : "passed",
    guarantees: [
      "sdk-archive-installable",
      "external-package-dist-only",
      "package-only-registry-compilation",
      "zero-context-typecheck",
      "all-workflows-executed",
      "tool-input-output-validation",
      "health-and-evals-executed",
      "renderer-resolution",
      "connection-authorization-required",
      "action-proposal-mutation-disabled",
    ],
    failureArtifacts: ["output/extension-contract", "output/conformance/extension-contract.json"],
    evidence,
    error: failure instanceof Error ? failure.message : failure ? String(failure) : null,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
};

const main = async () => {
  rmSync(output, { recursive: true, force: true });
  mkdirSync(consumer, { recursive: true });

  command(
    "sdk-pack",
    "pnpm",
    ["pack", "--pack-destination", output],
    resolve(root, "packages/agent-sdk"),
  );
  command(
    "fixture-pack",
    "pnpm",
    ["pack", "--pack-destination", output],
    resolve(root, "examples/complex-operator"),
  );
  const sdkArchive = archive("operloom-agent-sdk-");
  const fixtureArchive = archive("operloom-pack-complex-operator-");

  const entries = command("fixture-archive-list", "tar", ["-tzf", fixtureArchive], root, {
    print: false,
  })
    .split("\n")
    .filter(Boolean);
  const required = ["manifest", "control-plane", "runner", "web"].flatMap((subpath) => [
    `package/dist/${subpath}.js`,
    `package/dist/${subpath}.d.ts`,
  ]);
  for (const file of required) {
    if (!entries.includes(file)) throw new Error(`Complex Operator archive is missing ${file}.`);
  }
  if (
    entries.some(
      (entry) =>
        entry.startsWith("package/src/") ||
        (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) ||
        entry.includes("generated/") ||
        entry.includes("node_modules/") ||
        entry.includes(".env") ||
        entry.includes(".assistant-mk1") ||
        entry.includes(".wrangler"),
    )
  ) {
    throw new Error(
      "Complex Operator archive contains source, generated, credential, or local state.",
    );
  }
  const packedMetadata = command(
    "fixture-package-metadata",
    "tar",
    ["-xOf", fixtureArchive, "package/package.json"],
    root,
    { print: false },
  );
  if (
    packedMetadata.includes("workspace:") ||
    packedMetadata.includes("./manifest.ts") ||
    packedMetadata.includes("../")
  ) {
    throw new Error("Complex Operator archive retains workspace or source-only package metadata.");
  }
  for (const entry of entries.filter((candidate) => candidate.endsWith(".js"))) {
    const source = command(
      `inspect-${entry.replaceAll("/", "-")}`,
      "tar",
      ["-xOf", fixtureArchive, entry],
      root,
      { print: false },
    );
    if (source.includes(root) || source.includes("../../") || source.includes("generated/")) {
      throw new Error(`${entry} contains a repository-relative runtime import.`);
    }
  }

  writeFileSync(
    resolve(consumer, "package.json"),
    `${JSON.stringify(
      {
        name: "operloom-extension-contract-consumer",
        private: true,
        type: "module",
        dependencies: {
          "@operloom/agent-sdk": `file:${relative(consumer, sdkArchive)}`,
          "@operloom/pack-complex-operator": `file:${relative(consumer, fixtureArchive)}`,
        },
        pnpm: {
          overrides: {
            "@operloom/agent-sdk": `file:${relative(consumer, sdkArchive)}`,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  command(
    "zero-context-install",
    "pnpm",
    ["install", "--ignore-workspace", "--prefer-offline"],
    consumer,
  );
  writeFileSync(
    resolve(consumer, "workbench.config.ts"),
    `import { defineWorkbenchConfig } from "@operloom/agent-sdk";

export default defineWorkbenchConfig({
  runtimeApiVersion: 1,
  workbenchVersion: "0.5.0",
  modules: [{ package: "@operloom/pack-complex-operator" }],
});
`,
  );
  writeFileSync(
    resolve(consumer, "consumer.ts"),
    `import { manifest } from "@operloom/pack-complex-operator/manifest";
import { controlPlane } from "@operloom/pack-complex-operator/control-plane";
import { runner } from "@operloom/pack-complex-operator/runner";
import { web } from "@operloom/pack-complex-operator/web";
void [manifest, controlPlane, runner, web];
`,
  );
  writeFileSync(
    resolve(consumer, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          skipLibCheck: false,
        },
        include: ["consumer.ts", "workbench.config.ts", "generated/**/*.ts"],
      },
      null,
      2,
    )}\n`,
  );

  const compiled = await compileAgentPacks(consumer, { check: false });
  if (compiled.modules.length !== 1 || compiled.modules[0]?.entry.source) {
    throw new Error("Complex Operator did not compile through the installed-package path.");
  }
  command(
    "zero-context-typecheck",
    "pnpm",
    ["exec", "tsc", "-p", resolve(consumer, "tsconfig.json")],
    root,
  );
  const conformanceStarted = Date.now();
  const packageReport = await runAgentPackConformance(consumer, "complex-operator");
  if (
    packageReport.workflowCount < 2 ||
    !packageReport.results.some((result) => result.id === "renderer.complex_operator_report") ||
    !packageReport.results.some((result) => result.id === "action.mutation-disabled")
  ) {
    throw new Error("Installed Complex Operator did not exercise its complete extension contract.");
  }
  evidence.push({
    id: "installed-package-conformance",
    status: "passed",
    durationMs: Date.now() - conformanceStarted,
    summary: `${packageReport.results.length} checks across ${packageReport.workflowCount} workflows passed.`,
  });
  const report = writeReport();
  console.log(`Extension contract ${report.status}: ${evidence.length} executable evidence rows.`);
};

main().catch((error) => {
  writeReport(error);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
