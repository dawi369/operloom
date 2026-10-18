import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { environmentTargets, loadWorkbenchEnvironment } from "./workbench-environment";

/**
 * A worker-only environment is a Cloudflare Worker with no Fly runner and no hosted console:
 * the local console and native shells point at it. It renders a secret-free wrangler config
 * from a tracked manifest so any checkout can deploy it; secrets go through `wrangler secret`.
 */
export type WorkerEnvironment = {
  schemaVersion: 1;
  kind: "worker-only";
  name: string;
  description?: string;
  cloudflare: {
    workerName: string;
    d1DatabaseName: string;
    d1DatabaseId: string;
    r2BucketName: string;
    origin: string;
  };
  consoleOrigin: string;
  workos: { issuer: string; jwksUrl: string; allowedClientIds: readonly string[] };
  mcpAllowedClientIds: readonly string[];
  features: { retainedData: boolean; connections: boolean; mutations: boolean; push: boolean };
  conformanceMode: boolean;
  vaultBackend: "memory" | "workos";
  billingProvider: "manual" | "stripe" | "polar";
  model: string;
  /** Present when the Worker sends email itself; the key is set through `secrets`. */
  email?: { provider: "resend"; from: string; replyTo?: string };
  secretEnvironmentVariables: { openrouter: string; workosApiKey: string; resend?: string };
};

/** Signing secrets the platform generates itself; nobody needs to know their values. */
export const generatedWorkerSecrets = [
  "OPERLOOM_RUNNER_SIGNING_SECRET",
  "OPERLOOM_CALLBACK_SIGNING_SECRET",
  "OPERLOOM_AGENT_CONNECTION_SECRET",
  "OPERLOOM_OPERATOR_ALERT_SIGNING_SECRET",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const clientId = /^[A-Za-z0-9_-]{3,80}$/;

export const parseWorkerEnvironment = (value: unknown): WorkerEnvironment => {
  const failures: string[] = [];
  const root = isRecord(value) ? value : {};
  const str = (object: Record<string, unknown>, key: string, path: string) => {
    const candidate = object[key];
    if (typeof candidate !== "string" || !candidate.trim()) failures.push(`${path} is required`);
    return typeof candidate === "string" ? candidate.trim() : "";
  };
  const bool = (object: Record<string, unknown>, key: string, path: string) => {
    if (typeof object[key] !== "boolean") failures.push(`${path} must be boolean`);
    return object[key] === true;
  };
  const ids = (object: Record<string, unknown>, key: string, path: string) => {
    const list = Array.isArray(object[key]) ? (object[key] as unknown[]) : [];
    if (!list.length) failures.push(`${path} must list at least one id`);
    return list.map((item) => {
      if (typeof item !== "string" || !clientId.test(item))
        failures.push(`${path} has an invalid id`);
      return String(item);
    });
  };
  const httpsOrigin = (raw: string, path: string, allowHttp = false) => {
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:"))
        failures.push(`${path} must use https`);
      if (url.origin !== raw.replace(/\/$/, "")) failures.push(`${path} must be an origin`);
    } catch {
      failures.push(`${path} is not a URL`);
    }
    return raw;
  };
  if (root.schemaVersion !== 1) failures.push("schemaVersion must be 1");
  if (root.kind !== "worker-only") failures.push('kind must be "worker-only"');
  const cloudflare = isRecord(root.cloudflare) ? root.cloudflare : {};
  const workos = isRecord(root.workos) ? root.workos : {};
  const features = isRecord(root.features) ? root.features : {};
  const secrets = isRecord(root.secretEnvironmentVariables) ? root.secretEnvironmentVariables : {};
  const name = str(root, "name", "name");
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) failures.push("name must be a short lowercase slug");
  if ((environmentTargets as readonly string[]).includes(name))
    failures.push(`name ${name} collides with a full environment target`);
  const d1DatabaseId = str(cloudflare, "d1DatabaseId", "cloudflare.d1DatabaseId");
  if (d1DatabaseId && !uuid.test(d1DatabaseId))
    failures.push("cloudflare.d1DatabaseId must be a UUID");
  const vaultBackend = str(root, "vaultBackend", "vaultBackend");
  if (vaultBackend !== "memory" && vaultBackend !== "workos")
    failures.push("vaultBackend must be memory|workos");
  const billingProvider = str(root, "billingProvider", "billingProvider");
  if (!["manual", "stripe", "polar"].includes(billingProvider))
    failures.push("billingProvider must be manual|stripe|polar");
  const parsed: WorkerEnvironment = {
    schemaVersion: 1,
    kind: "worker-only",
    name,
    ...(typeof root.description === "string" ? { description: root.description } : {}),
    cloudflare: {
      workerName: str(cloudflare, "workerName", "cloudflare.workerName"),
      d1DatabaseName: str(cloudflare, "d1DatabaseName", "cloudflare.d1DatabaseName"),
      d1DatabaseId,
      r2BucketName: str(cloudflare, "r2BucketName", "cloudflare.r2BucketName"),
      origin: httpsOrigin(str(cloudflare, "origin", "cloudflare.origin"), "cloudflare.origin"),
    },
    consoleOrigin: httpsOrigin(str(root, "consoleOrigin", "consoleOrigin"), "consoleOrigin", true),
    workos: {
      issuer: str(workos, "issuer", "workos.issuer"),
      jwksUrl: str(workos, "jwksUrl", "workos.jwksUrl"),
      allowedClientIds: ids(workos, "allowedClientIds", "workos.allowedClientIds"),
    },
    mcpAllowedClientIds: ids(root, "mcpAllowedClientIds", "mcpAllowedClientIds"),
    features: {
      retainedData: bool(features, "retainedData", "features.retainedData"),
      connections: bool(features, "connections", "features.connections"),
      mutations: bool(features, "mutations", "features.mutations"),
      push: bool(features, "push", "features.push"),
    },
    conformanceMode: bool(root, "conformanceMode", "conformanceMode"),
    vaultBackend: vaultBackend as "memory" | "workos",
    billingProvider: billingProvider as WorkerEnvironment["billingProvider"],
    model: str(root, "model", "model"),
    secretEnvironmentVariables: {
      openrouter: str(secrets, "openrouter", "secretEnvironmentVariables.openrouter"),
      workosApiKey: str(secrets, "workosApiKey", "secretEnvironmentVariables.workosApiKey"),
      ...(typeof secrets.resend === "string" ? { resend: secrets.resend } : {}),
    },
  };
  if (isRecord(root.email)) {
    const email = root.email;
    if (email.provider !== "resend") failures.push('email.provider must be "resend"');
    const from = str(email, "from", "email.from");
    if (!/<[^@\s]+@[^@\s]+>$|^[^@\s]+@[^@\s]+$/.test(from))
      failures.push("email.from must be an address");
    parsed.email = {
      provider: "resend",
      from,
      ...(typeof email.replyTo === "string" ? { replyTo: email.replyTo } : {}),
    };
    if (!parsed.secretEnvironmentVariables.resend)
      failures.push("email requires secretEnvironmentVariables.resend");
  }
  // The issuer carries a path, so it is checked by prefix rather than as a bare origin.
  if (!parsed.workos.issuer.startsWith("https://")) failures.push("workos.issuer must use https");
  if (!parsed.workos.jwksUrl.startsWith("https://")) failures.push("workos.jwksUrl must use https");
  if (failures.length) throw new Error(failures.join("; "));
  return parsed;
};

export const loadWorkerEnvironment = (name: string) => {
  const path = resolve(process.cwd(), "config/environments", `${name}.json`);
  if (!existsSync(path)) throw new Error(`no environment manifest at ${path}`);
  return parseWorkerEnvironment(JSON.parse(readFileSync(path, "utf8")));
};

/** Worker-only names and Cloudflare resources must not collide with the full targets. */
export const validateWorkerEnvironmentAgainstTargets = (manifest: WorkerEnvironment) => {
  const failures: string[] = [];
  for (const target of environmentTargets) {
    const other = loadWorkbenchEnvironment(target).cloudflare;
    for (const [key, value] of [
      ["workerName", other.workerName],
      ["d1DatabaseName", other.d1DatabaseName],
      ["r2BucketName", other.r2BucketName],
    ] as const) {
      if (manifest.cloudflare[key] === value)
        failures.push(`cloudflare.${key} is shared with ${target}`);
    }
  }
  return failures;
};

export const renderWorkerEnvironment = (
  manifest: WorkerEnvironment,
  options: { releaseSha?: string } = {},
) => {
  const releaseSha = options.releaseSha ?? "development";
  const directory = resolve(process.cwd(), "output/environments", manifest.name);
  mkdirSync(directory, { recursive: true });
  const wrangler = {
    $schema: "../../../node_modules/wrangler/config-schema.json",
    name: manifest.cloudflare.workerName,
    main: "../../../cloudflare/control-plane/src/index.ts",
    compatibility_date: "2026-06-01",
    compatibility_flags: ["nodejs_compat", "nodejs_als"],
    workers_dev: true,
    preview_urls: false,
    vars: {
      OPENROUTER_MODEL: manifest.model,
      OPENROUTER_SITE_URL: manifest.consoleOrigin,
      OPENROUTER_APP_NAME: `operloom-${manifest.name}-cloudflare-chat`,
      OPERLOOM_ENVIRONMENT: manifest.name,
      OPERLOOM_CALLBACK_URL: `${manifest.cloudflare.origin}/workbench/run-callbacks`,
      // No Fly app: heavy tools run inline in the Worker.
      OPERLOOM_RUNNER_TRANSPORT: "inline",
      OPERLOOM_CONFORMANCE_MODE: String(manifest.conformanceMode),
      OPERLOOM_RETAINED_DATA_ENABLED: String(manifest.features.retainedData),
      OPERLOOM_CONNECTIONS_ENABLED: String(manifest.features.connections),
      OPERLOOM_MUTATIONS_ENABLED: String(manifest.features.mutations),
      OPERLOOM_PUSH_ENABLED: String(manifest.features.push),
      OPERLOOM_VAULT_BACKEND: manifest.vaultBackend,
      OPERLOOM_BILLING_PROVIDER: manifest.billingProvider,
      OPERLOOM_WORKOS_ISSUER: manifest.workos.issuer,
      OPERLOOM_WORKOS_JWKS_URL: manifest.workos.jwksUrl,
      OPERLOOM_WORKOS_ALLOWED_CLIENT_IDS: manifest.workos.allowedClientIds.join(","),
      OPERLOOM_MCP_ALLOWED_CLIENT_IDS: manifest.mcpAllowedClientIds.join(","),
      ...(manifest.email
        ? {
            OPERLOOM_EMAIL_PROVIDER: manifest.email.provider,
            OPERLOOM_EMAIL_FROM: manifest.email.from,
            ...(manifest.email.replyTo ? { OPERLOOM_EMAIL_REPLY_TO: manifest.email.replyTo } : {}),
          }
        : {}),
      OPERLOOM_RELEASE_SHA: releaseSha,
      SENTRY_ENVIRONMENT: manifest.name,
      SENTRY_TRACES_SAMPLE_RATE: "0",
    },
    triggers: { crons: ["* * * * *"] },
    d1_databases: [
      {
        binding: "DB",
        database_name: manifest.cloudflare.d1DatabaseName,
        database_id: manifest.cloudflare.d1DatabaseId,
        migrations_dir: "../../../cloudflare/control-plane/migrations",
        migrations_table: "d1_migrations",
      },
    ],
    r2_buckets: [{ binding: "ARTIFACTS", bucket_name: manifest.cloudflare.r2BucketName }],
    workflows: [
      {
        binding: "DURABLE_WORKFLOWS",
        name: `${manifest.cloudflare.workerName}-durable`,
        class_name: "OperloomDurableWorkflow",
      },
    ],
    durable_objects: {
      bindings: [
        { name: "ThreadChatAgent", class_name: "ThreadChatAgent" },
        { name: "SessionAgent", class_name: "SessionAgent" },
      ],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["ThreadChatAgent", "SessionAgent"] }],
  };
  const wranglerPath = resolve(directory, "wrangler.json");
  writeFileSync(wranglerPath, `${JSON.stringify(wrangler, null, 2)}\n`, { mode: 0o600 });
  return { directory, wranglerPath, wrangler };
};

const run = (command: string, args: string[], input?: string) => {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    input,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`${command} ${args[0]} exited with ${result.status}`);
};
const git = (...args: string[]) => {
  const result = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "development";
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const [action, ...rest] = process.argv.slice(2);
  const name = rest[rest.indexOf("--name") + 1] || "staging";
  const manifest = loadWorkerEnvironment(name);
  const collisions = validateWorkerEnvironmentAgainstTargets(manifest);
  if (collisions.length) throw new Error(collisions.join("; "));
  const rendered = renderWorkerEnvironment(manifest, { releaseSha: git("rev-parse", "HEAD") });
  const wrangler = (...args: string[]) =>
    run("pnpm", ["exec", "wrangler", ...args, "--config", rendered.wranglerPath]);
  switch (action) {
    case "check":
      console.log(`Worker environment ${name} is valid (${manifest.cloudflare.workerName}).`);
      break;
    case "render":
      console.log(`Rendered ${rendered.wranglerPath}.`);
      break;
    case "migrate":
      wrangler("d1", "migrations", "apply", manifest.cloudflare.d1DatabaseName, "--remote");
      break;
    case "deploy":
      wrangler("deploy");
      break;
    case "secrets": {
      // Signing secrets are rotated to fresh random values; provider keys come from the named
      // variables and are skipped when absent so a partial rotation never clears a key.
      for (const secret of generatedWorkerSecrets)
        run(
          "pnpm",
          ["exec", "wrangler", "secret", "put", secret, "--config", rendered.wranglerPath],
          `${randomBytes(48).toString("base64url")}\n`,
        );
      for (const [secret, variable] of [
        ["OPENROUTER_API_KEY", manifest.secretEnvironmentVariables.openrouter],
        ["WORKOS_API_KEY", manifest.secretEnvironmentVariables.workosApiKey],
        ...(manifest.secretEnvironmentVariables.resend
          ? ([["RESEND_API_KEY", manifest.secretEnvironmentVariables.resend]] as const)
          : []),
      ] as const) {
        const value = process.env[variable]?.trim();
        if (!value) {
          console.log(`Skipped ${secret}: ${variable} is not set.`);
          continue;
        }
        run(
          "pnpm",
          ["exec", "wrangler", "secret", "put", secret, "--config", rendered.wranglerPath],
          `${value}\n`,
        );
      }
      break;
    }
    case "smoke": {
      const origin = manifest.cloudflare.origin;
      const checks: [string, string, number][] = [
        ["GET", "/health", 200],
        ["GET", "/v1/me/workbench/memory", 401],
        ["GET", "/v1/me/admin/events", 401],
        ["POST", "/v1/me/mcp", 401],
      ];
      void (async () => {
        let failed = false;
        for (const [method, path, expected] of checks) {
          const response = await fetch(`${origin}${path}`, { method });
          const ok = response.status === expected;
          failed ||= !ok;
          console.log(`${ok ? "ok " : "BAD"} ${method} ${path} → ${response.status}`);
        }
        if (failed) process.exitCode = 1;
      })();
      break;
    }
    default:
      throw new Error(
        "usage: worker-environment <check|render|migrate|deploy|secrets|smoke> [--name staging]",
      );
  }
}
