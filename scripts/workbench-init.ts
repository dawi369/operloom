import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { diagnoseWorkbench } from "./workbench-doctor-core";
import { assessLocalNodeRuntime } from "./node-runtime";

type InitOptions = {
  root: string;
  runMigration: boolean;
};

type InitResult = {
  created: string[];
  configured: string[];
  needsProviderKey: boolean;
};

const placeholder = (value: string | undefined) =>
  !value?.trim() || value.trim().startsWith("replace-with-");

const readValue = (source: string, key: string) => {
  const line = source.split(/\r?\n/).find((candidate) => candidate.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim();
};

const setPlaceholderValue = (
  source: string,
  key: string,
  value: string,
  replaceableValues: readonly string[] = [],
) => {
  const lines = source.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (index < 0) {
    lines.push(`${key}=${value}`);
    return { source: lines.join("\n"), changed: true };
  }
  const current = lines[index]?.slice(key.length + 1).trim();
  if (!placeholder(current) && !replaceableValues.includes(current ?? "")) {
    return { source, changed: false };
  }
  lines[index] = `${key}=${value}`;
  return { source: lines.join("\n"), changed: true };
};

const writeConfiguredFile = (
  absolute: string,
  source: string,
  values: Readonly<Record<string, string>>,
  replaceableValues: Readonly<Record<string, readonly string[]>> = {},
) => {
  let next = source;
  const configured: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const result = setPlaceholderValue(next, key, value, replaceableValues[key]);
    next = result.source;
    if (result.changed) configured.push(key);
  }
  if (next !== source)
    writeFileSync(absolute, next.endsWith("\n") ? next : `${next}\n`, { mode: 0o600 });
  return configured;
};

const sharedValue = (first: string | undefined, second: string | undefined) => {
  if (!placeholder(first)) return first!;
  if (!placeholder(second)) return second!;
  return randomBytes(32).toString("base64url");
};

export const initializeWorkbench = async ({
  root,
  runMigration,
}: InitOptions): Promise<InitResult> => {
  const frontendPath = resolve(root, ".env.local");
  const workerDirectory = resolve(root, "cloudflare/control-plane");
  const workerPath = resolve(workerDirectory, ".dev.vars");
  const created: string[] = [];
  mkdirSync(workerDirectory, { recursive: true });

  if (!existsSync(frontendPath)) {
    copyFileSync(resolve(root, ".env.example"), frontendPath);
    created.push(".env.local");
  }
  if (!existsSync(workerPath)) {
    copyFileSync(resolve(root, "cloudflare/control-plane/.dev.vars.example"), workerPath);
    created.push("cloudflare/control-plane/.dev.vars");
  }

  const frontend = readFileSync(frontendPath, "utf8");
  const worker = readFileSync(workerPath, "utf8");
  const transportToken = sharedValue(
    readValue(frontend, "CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN"),
    readValue(worker, "CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN"),
  );
  const callbackSecret = sharedValue(
    readValue(frontend, "WORKBENCH_CALLBACK_SIGNING_SECRET"),
    readValue(worker, "WORKBENCH_CALLBACK_SIGNING_SECRET"),
  );
  const agentConnectionSecret = sharedValue(
    undefined,
    readValue(worker, "WORKBENCH_AGENT_CONNECTION_SECRET"),
  );
  const runnerSigningSecret = sharedValue(
    readValue(frontend, "WORKBENCH_RUNNER_SIGNING_SECRET"),
    readValue(worker, "WORKBENCH_RUNNER_SIGNING_SECRET"),
  );
  const configured = [
    ...writeConfiguredFile(frontendPath, frontend, {
      CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN: transportToken,
      WORKBENCH_CALLBACK_SIGNING_SECRET: callbackSecret,
      WORKBENCH_RUNNER_SIGNING_SECRET: runnerSigningSecret,
      WORKBENCH_ADMIN_USER_IDS: readValue(frontend, "WORKBENCH_DEV_USER_ID") || "dev-user",
    }).map((key) => `.env.local:${key}`),
    ...writeConfiguredFile(
      workerPath,
      worker,
      {
        CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN: transportToken,
        WORKBENCH_AGENT_CONNECTION_SECRET: agentConnectionSecret,
        WORKBENCH_CALLBACK_SIGNING_SECRET: callbackSecret,
        WORKBENCH_RUNNER_SIGNING_SECRET: runnerSigningSecret,
        WORKBENCH_RUNNER_TRANSPORT: "fly",
        WORKBENCH_RUNNER_URL: "http://127.0.0.1:3101/workbench/tool-runners/invocations",
        WORKBENCH_CALLBACK_URL: "http://127.0.0.1:8787/workbench/run-callbacks",
      },
      {
        WORKBENCH_RUNNER_TRANSPORT: ["inline"],
      },
    ).map((key) => `cloudflare/control-plane/.dev.vars:${key}`),
  ];

  if (runMigration) {
    const migration = spawnSync("pnpm", ["db:cloudflare:migrate:local"], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    if (migration.status !== 0) throw new Error("Local D1 migration failed");
  }

  const result = await diagnoseWorkbench({
    root,
    offline: true,
    environment: {},
    allowMissingProviderKey: true,
  });
  if (result.failures.length) throw new Error(result.failures.join("\n"));

  const initializedWorker = readFileSync(workerPath, "utf8");
  return {
    created,
    configured,
    needsProviderKey: placeholder(readValue(initializedWorker, "OPENROUTER_API_KEY")),
  };
};

const main = async () => {
  const checkOnly = process.argv.includes("--check");
  if (checkOnly) {
    const result = await diagnoseWorkbench({ root: process.cwd(), offline: true });
    for (const check of result.checks) console.log(`ok - ${check}`);
    if (result.failures.length) throw new Error(result.failures.join("\n"));
    console.log("Workbench local setup is ready.");
    return;
  }
  const nodeRuntime = assessLocalNodeRuntime();
  if (!nodeRuntime.supported) throw new Error(nodeRuntime.message);
  const result = await initializeWorkbench({
    root: process.cwd(),
    runMigration: !process.argv.includes("--no-migrate"),
  });
  for (const file of result.created) console.log(`created - ${file}`);
  for (const key of result.configured) console.log(`configured - ${key}`);
  if (result.needsProviderKey) {
    console.log("next - set OPENROUTER_API_KEY in cloudflare/control-plane/.dev.vars");
  }
  console.log("next - pnpm workbench dev");
  console.log("next - run pnpm workbench doctor in another terminal");
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
