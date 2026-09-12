import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildProviderSecretConfiguration,
  type HostedSecretRoleValues,
} from "./configure-environment-secrets-core";
import { renderEnvironmentConfig } from "./render-environment-config";
import {
  isEnvironmentTarget,
  loadWorkbenchEnvironment,
  validateEnvironmentSecretValues,
} from "./workbench-environment";

const valueAfter = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const git = (...args: string[]) => {
  const result = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
};
const runWithInput = (
  command: string,
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv = process.env,
) => {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    input,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? "signal"}`);
};
const verifyWorkerExists = (wranglerPath: string) => {
  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", "deployments", "list", "--config", wranglerPath, "--json"],
    { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(
      "Cloudflare Worker does not exist; run the guarded non-public bootstrap deployment before configuring secrets",
    );
  }
};

const target = valueAfter("--target") ?? "";
if (!isEnvironmentTarget(target) || target === "local") {
  throw new Error("--target must be acceptance|production|demo");
}
const manifest = loadWorkbenchEnvironment(target);
const execute = process.argv.includes("--execute");
const sha = git("rev-parse", "HEAD");
const confirmation = `${target}:configure-secrets:${sha}`;
const roles = manifest.secretEnvironmentVariables;
const roleValues = Object.fromEntries(
  Object.entries(roles).map(([role, variable]) => [role, process.env[variable]?.trim() ?? ""]),
) as HostedSecretRoleValues;
const observability = {
  sentryDsn: process.env[manifest.observabilityEnvironmentVariables.sentryDsn]?.trim() ?? "",
  sentryAuthToken:
    process.env[manifest.observabilityEnvironmentVariables.sentryAuthToken]?.trim() ?? "",
};

if (!execute) {
  console.log(`Dry run only: configure ${target} provider secret roles at ${sha}.`);
  console.log(`Required source variables: ${Object.values(roles).join(", ")}.`);
  console.log(
    `Required observability variables: ${Object.values(manifest.observabilityEnvironmentVariables).join(", ")}.`,
  );
  console.log(`Re-run with --execute --confirm ${confirmation} after approval is recorded.`);
  process.exit(0);
}
if (valueAfter("--confirm") !== confirmation) {
  throw new Error(`execution requires --confirm ${confirmation}`);
}
if (git("status", "--porcelain")) throw new Error("secret configuration requires a clean worktree");
const secretFailures = validateEnvironmentSecretValues([manifest]);
if (!observability.sentryDsn.startsWith("https://")) {
  secretFailures.push(`${target} Sentry DSN is missing or invalid`);
}
if (observability.sentryAuthToken.length < 32) {
  secretFailures.push(`${target} Sentry auth token is missing or too short`);
}
if (secretFailures.length) throw new Error(secretFailures.join("; "));

const rendered = renderEnvironmentConfig(target);
verifyWorkerExists(rendered.wranglerPath);
const { workerSecrets, flySecrets, webSecrets, webVariables } = buildProviderSecretConfiguration(
  rendered.manifest,
  roleValues,
  observability,
);
for (const [name, value] of Object.entries(workerSecrets)) {
  runWithInput(
    "pnpm",
    ["exec", "wrangler", "secret", "put", name, "--config", rendered.wranglerPath],
    `${value}\n`,
  );
}

runWithInput(
  "fly",
  ["secrets", "import", "--stage", "--app", rendered.manifest.fly.appName],
  Object.entries(flySecrets)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n") + "\n",
);

if (rendered.manifest.web.provider === "vercel") {
  const vercelProcessEnv = {
    ...process.env,
    VERCEL_ORG_ID: rendered.manifest.web.organizationId,
    VERCEL_PROJECT_ID: rendered.manifest.web.projectId,
  };
  for (const [name, value] of Object.entries(webSecrets)) {
    runWithInput(
      "vercel",
      ["env", "add", name, "production", "--force", "--yes", "--sensitive"],
      `${value}\n`,
      vercelProcessEnv,
    );
  }
  for (const [name, value] of Object.entries({ ...webVariables, WORKBENCH_RELEASE_SHA: sha })) {
    runWithInput(
      "vercel",
      ["env", "add", name, "production", "--force", "--yes", "--no-sensitive"],
      `${value}\n`,
      vercelProcessEnv,
    );
  }
} else {
  const railwayArgs = [
    "variable",
    "set",
    "--project",
    rendered.manifest.web.projectId,
    "--environment",
    rendered.manifest.web.environmentId,
    "--service",
    rendered.manifest.web.serviceId,
    "--skip-deploys",
  ];
  const railwayEnv = {
    ...process.env,
    RAILWAY_CALLER: "skill:use-railway@1.2.1",
    RAILWAY_AGENT_SESSION: `operloom-${target}-${sha.slice(0, 12)}`,
  };
  for (const [name, value] of Object.entries({
    ...webSecrets,
    ...webVariables,
    WORKBENCH_RELEASE_SHA: sha,
  })) {
    runWithInput("railway", [...railwayArgs, name, "--stdin"], `${value}\n`, railwayEnv);
  }
}
const evidenceDirectory = resolve(process.cwd(), "output/release", sha);
mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(
  resolve(evidenceDirectory, `secret-configuration-${target}.json`),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      target,
      commit: sha,
      status: "configured",
      fingerprints: Object.fromEntries(
        Object.entries({ ...roleValues, ...observability }).map(([role, value]) => [
          role,
          createHash("sha256").update(value).digest("hex"),
        ]),
      ),
      providers: {
        cloudflare: Object.keys(workerSecrets),
        fly: Object.keys(flySecrets),
        web: Object.keys(webSecrets),
      },
      completedAt: new Date().toISOString(),
      operator: process.env.WORKBENCH_RELEASE_OPERATOR?.trim() || process.env.USER || "unknown",
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
console.log(
  `Configured ${target} secret roles in Cloudflare, Fly, and ${rendered.manifest.web.provider} without disclosure.`,
);
