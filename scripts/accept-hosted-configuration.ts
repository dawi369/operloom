import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  parseCloudflareEnvironmentInventory,
  parseFlyEnvironmentInventory,
  parseVercelEnvironmentInventory,
  validateHostedConfiguration,
  type HostedVariableInventory,
} from "./hosted-configuration-core";
import {
  isEnvironmentTarget,
  loadWorkbenchEnvironment,
  resolveEnvironmentReferences,
} from "./workbench-environment";

const valueAfter = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const run = (command: string, args: string[], env: NodeJS.ProcessEnv = process.env) => {
  const result = spawnSync(command, args, { cwd: process.cwd(), env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} metadata query failed`);
  return result.stdout;
};
const git = (...args: string[]) => run("git", args).trim();
const target = valueAfter("--target") ?? "";
if (!isEnvironmentTarget(target) || target === "local") {
  throw new Error("--target must be acceptance|production");
}
const resolved = resolveEnvironmentReferences(loadWorkbenchEnvironment(target));
if (resolved.unresolved.length) {
  throw new Error(`missing target metadata variables: ${resolved.unresolved.join(", ")}`);
}
const manifest = resolved.manifest;
const commit = process.env.GITHUB_SHA?.trim() || git("rev-parse", "HEAD");
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("hosted configuration requires a full commit");

const vercelEnv = {
  ...process.env,
  VERCEL_ORG_ID: manifest.vercel.organizationId,
  VERCEL_PROJECT_ID: manifest.vercel.projectId,
};
const vercel = parseVercelEnvironmentInventory(
  run("vercel", ["env", "ls", "production"], vercelEnv),
);
const versions = JSON.parse(
  run("pnpm", [
    "exec",
    "wrangler",
    "versions",
    "list",
    "--name",
    manifest.cloudflare.workerName,
    "--json",
  ]),
) as { id?: unknown; number?: unknown }[];
const latest = [...versions]
  .filter(
    (version): version is { id: string; number: number } =>
      typeof version.id === "string" && typeof version.number === "number",
  )
  .sort((left, right) => right.number - left.number)[0];
if (!latest) throw new Error("Cloudflare has no deployed version metadata");
const cloudflare = parseCloudflareEnvironmentInventory(
  run("pnpm", [
    "exec",
    "wrangler",
    "versions",
    "view",
    latest.id,
    "--name",
    manifest.cloudflare.workerName,
    "--json",
  ]),
);
const fly = parseFlyEnvironmentInventory(
  run("fly", ["config", "show", "--app", manifest.fly.appName, "--toml"]),
  run("fly", ["secrets", "list", "--app", manifest.fly.appName, "--json"]),
);
const inventory: HostedVariableInventory = { vercel, cloudflare, fly };
const failures = validateHostedConfiguration(manifest, inventory, commit);

const readHealth = async (origin: string, path: string, expectedService: string) => {
  const response = await fetch(`${origin}${path}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || body?.ok !== true || body.service !== expectedService) {
    failures.push(`${expectedService} health failed`);
  } else if (body.release !== commit) failures.push(`${expectedService} release does not match`);
  return {
    service: expectedService,
    status: response.status,
    release: body?.release,
    version: body?.version,
  };
};
const main = async () => {
  const health = await Promise.all([
    readHealth(manifest.vercel.origin, "/api/health", "operloom"),
    readHealth(manifest.cloudflare.origin, "/health", "operloom-control-plane"),
    readHealth(manifest.fly.origin, "/health", "operloom-langgraph-runtime"),
  ]);
  if (new Set(health.map((item) => item.release)).size !== 1) {
    failures.push("hosted services report different releases");
  }
  if (new Set(health.map((item) => item.version)).size !== 1) {
    failures.push("hosted services report different versions");
  }

  const report = {
    schemaVersion: 1,
    target,
    commit,
    generatedAt: new Date().toISOString(),
    ok: failures.length === 0,
    services: Object.fromEntries(
      (Object.entries(inventory) as [string, ReadonlyMap<string, string | null>][]).map(
        ([service, values]) => [service, { variableNames: [...values.keys()].sort() }],
      ),
    ),
    health,
    failures,
  };
  const directory = resolve(process.cwd(), "output/release", commit);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    resolve(directory, `hosted-configuration-${target}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 1;
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
