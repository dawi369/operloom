import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderEnvironmentConfig } from "./render-environment-config";
import { isEnvironmentTarget } from "./workbench-environment";

type CommandResult = { ok: true; output: string } | { ok: false; output: string };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requestedTarget = process.env.WORKBENCH_ENVIRONMENT?.trim() ?? "";
if (!isEnvironmentTarget(requestedTarget) || requestedTarget === "local") {
  throw new Error("WORKBENCH_ENVIRONMENT must be acceptance|production|demo");
}
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const rendered = renderEnvironmentConfig(requestedTarget, { releaseSha: commit });
const wranglerConfig = rendered.wranglerPath;
const expectedBucket = rendered.manifest.cloudflare.r2BucketName;
const requiredWorkerSecrets = [
  "CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET",
  "WORKBENCH_RUNNER_SIGNING_SECRET",
  "WORKBENCH_CALLBACK_SIGNING_SECRET",
  "WORKBENCH_AGENT_CONNECTION_SECRET",
  "WORKBENCH_OPERATOR_ALERT_SIGNING_SECRET",
  "LANGGRAPH_UPSTREAM_TOKEN",
  "WORKOS_API_KEY",
  "OPENROUTER_API_KEY",
] as const;
const requiredFlySecrets = [
  "WORKBENCH_RUNNER_SIGNING_SECRET",
  "WORKBENCH_CALLBACK_SIGNING_SECRET",
  "LANGGRAPH_PROXY_TOKEN",
  "OPENROUTER_API_KEY",
] as const;
const requiredWebVariables = [
  "CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET",
  "WORKBENCH_OPERATOR_ALERT_SIGNING_SECRET",
  "WORKOS_API_KEY",
  "WORKOS_COOKIE_PASSWORD",
  "WORKOS_CLIENT_ID",
  "CLOUDFLARE_CONTROL_PLANE_URL",
] as const;

const run = (command: string, args: string[]): CommandResult => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "true", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return result.status === 0 ? { ok: true, output } : { ok: false, output };
};

const jsonFromFirstArray = <T>(output: string): T => {
  const start = output.indexOf("[");
  if (start < 0) throw new Error("Expected a JSON array from infrastructure CLI.");
  return JSON.parse(output.slice(start)) as T;
};

const main = () => {
  const dirty = run("git", ["status", "--porcelain"]).output.trim().length > 0;
  const configSource = readFileSync(wranglerConfig, "utf8");
  const bindingDeclared =
    configSource.includes('"binding": "ARTIFACTS"') &&
    configSource.includes(`"bucket_name": "${expectedBucket}"`);
  const releaseBound = configSource.includes(`"WORKBENCH_RELEASE_SHA": "${commit}"`);

  const migrationResult = run("pnpm", [
    "exec",
    "wrangler",
    "d1",
    "migrations",
    "list",
    rendered.manifest.cloudflare.d1DatabaseName,
    "--remote",
    "--config",
    wranglerConfig,
  ]);
  const pendingMigrations = migrationResult.ok
    ? Array.from(migrationResult.output.matchAll(/\b\d{4}_[a-z0-9_]+\.sql\b/g), (match) => match[0])
    : ["migration_status_unavailable"];

  const workerSecretResult = run("pnpm", [
    "exec",
    "wrangler",
    "secret",
    "list",
    "--config",
    wranglerConfig,
  ]);
  const workerSecretNames = workerSecretResult.ok
    ? jsonFromFirstArray<Array<{ name: string }>>(workerSecretResult.output).map(
        (item) => item.name,
      )
    : [];
  const missingWorkerSecrets = requiredWorkerSecrets.filter(
    (name) => !workerSecretNames.includes(name),
  );

  const flySecretResult = run("fly", ["secrets", "list", "--app", rendered.manifest.fly.appName]);
  const missingFlySecrets = requiredFlySecrets.filter(
    (name) => !flySecretResult.ok || !flySecretResult.output.includes(name),
  );

  const webResult =
    rendered.manifest.web.provider === "vercel"
      ? run("pnpm", ["exec", "vercel", "env", "ls", "production"])
      : run("railway", [
          "variable",
          "list",
          "--project",
          rendered.manifest.web.projectId,
          "--environment",
          rendered.manifest.web.environmentId,
          "--service",
          rendered.manifest.web.serviceId,
          "--json",
        ]);
  const missingWebVariables = requiredWebVariables.filter(
    (name) => !webResult.ok || !webResult.output.includes(name),
  );

  const r2Result = run("pnpm", [
    "exec",
    "wrangler",
    "r2",
    "bucket",
    "list",
    "--config",
    wranglerConfig,
  ]);
  const r2Enabled = r2Result.ok;
  const bucketExists = r2Result.ok && r2Result.output.includes(expectedBucket);
  const r2FailureCode = r2Result.ok
    ? null
    : r2Result.output.includes("code: 10042")
      ? "r2_not_enabled"
      : "r2_status_unavailable";

  const checks = {
    cleanCommitEvidence: !dirty,
    artifactBindingDeclared: bindingDeclared,
    immutableReleaseBound: releaseBound,
    remoteMigrationsCurrent: migrationResult.ok && pendingMigrations.length === 0,
    r2Enabled,
    artifactBucketExists: bucketExists,
    workerSecretsPresent: missingWorkerSecrets.length === 0,
    flyTransportSecretsPresent: missingFlySecrets.length === 0,
    webConfigurationPresent: missingWebVariables.length === 0,
  };
  const report = {
    version: 1,
    target: requestedTarget,
    generatedAt: new Date().toISOString(),
    commit,
    dirty,
    ok: Object.values(checks).every(Boolean),
    checks,
    details: {
      pendingMigrations,
      expectedBucket,
      r2FailureCode,
      missingWorkerSecrets,
      missingFlySecrets,
      missingWebVariables,
    },
    nextActions: [
      ...(!r2Enabled ? ["Enable R2 for the Cloudflare account."] : []),
      ...(r2Enabled && !bucketExists ? [`Create R2 bucket ${expectedBucket}.`] : []),
      ...(pendingMigrations.length
        ? ["Export remote D1, checksum it, then apply pending migrations."]
        : []),
      ...(missingWorkerSecrets.length ? ["Configure every required Worker secret role."] : []),
      ...(missingFlySecrets.length ? ["Configure every required Fly secret role."] : []),
      ...(missingWebVariables.length
        ? [`Configure the matching ${rendered.manifest.web.provider} web variables.`]
        : []),
      ...(dirty
        ? ["Commit the verified worktree so hosted evidence can name one immutable SHA."]
        : []),
    ],
  };

  const outputDirectory = join(root, "output", "release", commit);
  mkdirSync(outputDirectory, { recursive: true });
  const outputPath = join(outputDirectory, "level3-hosted-preflight.json");
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ...report, outputPath }, null, 2));
  if (!report.ok) process.exitCode = 1;
};

main();
