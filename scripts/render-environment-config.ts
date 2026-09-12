import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  environmentTargets,
  isEnvironmentTarget,
  loadWorkbenchEnvironment,
  resolveEnvironmentReferences,
  type EnvironmentTarget,
} from "./workbench-environment";

export const featureStages = ["disabled", "retained-data", "connections", "mutations"] as const;
export type FeatureStage = (typeof featureStages)[number];

const featureFlags = (stage: FeatureStage) => ({
  retainedData: stage !== "disabled",
  connections: stage === "connections" || stage === "mutations",
  mutations: stage === "mutations",
});

export const renderEnvironmentConfig = (
  target: EnvironmentTarget,
  options: { bootstrap?: boolean; featureStage?: FeatureStage; releaseSha?: string } = {},
) => {
  const bootstrap = options.bootstrap ?? false;
  const featureStage = options.featureStage ?? "disabled";
  if (bootstrap && featureStage !== "disabled") {
    throw new Error("Cloudflare bootstrap requires feature stage disabled");
  }
  const resolved = resolveEnvironmentReferences(loadWorkbenchEnvironment(target));
  if (resolved.unresolved.length) {
    throw new Error(`missing required variables: ${resolved.unresolved.join(", ")}`);
  }
  const manifest = resolved.manifest;
  const isDemo = target === "demo";
  const features = isDemo
    ? { retainedData: true, connections: false, mutations: false }
    : featureFlags(featureStage);
  const flyHost = new URL(manifest.fly.origin).hostname;
  const conformanceProviders = manifest.conformanceMode
    ? JSON.stringify([
        {
          id: "synthetic-broker",
          authorizationUrl: `${manifest.fly.origin}/e2e/oauth/authorize`,
          tokenUrl: `${manifest.fly.origin}/e2e/oauth/token`,
          actionUrl: `${manifest.fly.origin}/e2e/actions`,
          clientId: "assistant-mk1-acceptance",
          permittedHosts: [flyHost],
          credentialPlacement: "bearer",
        },
      ])
    : undefined;
  const releaseSha = options.releaseSha ?? process.env.GITHUB_SHA?.trim() ?? "development";
  if (releaseSha !== "development" && !/^[a-f0-9]{40}$/.test(releaseSha)) {
    throw new Error("release SHA must be a full lowercase Git commit");
  }
  const directory = resolve(process.cwd(), "output/environments", target);
  mkdirSync(directory, { recursive: true });

  const wranglerPath = resolve(directory, "wrangler.json");
  const wrangler = {
    $schema: "../../../node_modules/wrangler/config-schema.json",
    name: manifest.cloudflare.workerName,
    preview_urls: false,
    main: "../../../cloudflare/control-plane/src/index.ts",
    compatibility_date: "2026-06-01",
    compatibility_flags: ["nodejs_compat", "nodejs_als"],
    workers_dev: !bootstrap,
    vars: {
      LANGGRAPH_UPSTREAM_URL: manifest.fly.origin,
      LANGGRAPH_ASSISTANT_ID: "agent",
      OPENROUTER_MODEL: "deepseek/deepseek-v4-flash",
      OPENROUTER_SITE_URL: manifest.web.origin,
      OPENROUTER_APP_NAME: `operloom-${target}-cloudflare-chat`,
      WORKBENCH_CALLBACK_URL: `${manifest.cloudflare.origin}/workbench/run-callbacks`,
      WORKBENCH_RUNNER_TRANSPORT: "fly",
      WORKBENCH_RUNNER_URL: `${manifest.fly.origin}/workbench/tool-runners/invocations`,
      WORKBENCH_OPERATOR_ALERT_WEBHOOK_URL: `${manifest.web.origin}/api/workbench/operator-alerts/ingest`,
      WORKBENCH_CONFORMANCE_MODE: String(manifest.conformanceMode),
      WORKBENCH_RETAINED_DATA_ENABLED: String(features.retainedData),
      WORKBENCH_CONNECTIONS_ENABLED: String(features.connections),
      WORKBENCH_MUTATIONS_ENABLED: String(features.mutations),
      WORKBENCH_PUSH_ENABLED: "false",
      WORKBENCH_VAULT_BACKEND: manifest.vaultBackend,
      ...(isDemo
        ? {
            WORKBENCH_DEMO_MODE: "true",
            WORKBENCH_DEMO_PACK_ALLOWLIST: JSON.stringify([
              "operloom",
              "repo-analyst",
              "baby-polymancer",
            ]),
            WORKBENCH_DEMO_CHAT_DAILY_LIMIT: "20",
            WORKBENCH_DEMO_WORKFLOW_DAILY_LIMIT: "3",
            WORKBENCH_DEMO_MODEL_BUDGET_USD: "20",
            WORKBENCH_DEMO_ARTIFACT_WORKSPACE_BYTES: String(20 * 1024 * 1024),
            WORKBENCH_DEMO_RETENTION_DAYS: "7",
          }
        : {}),
      ...(conformanceProviders ? { WORKBENCH_OAUTH_PROVIDERS_JSON: conformanceProviders } : {}),
      WORKBENCH_RELEASE_SHA: releaseSha,
      SENTRY_ENVIRONMENT: target,
      SENTRY_TRACES_SAMPLE_RATE: isDemo ? "0" : "0.02",
    },
    ...(bootstrap ? {} : { triggers: { crons: isDemo ? ["17 3 * * *"] : [] } }),
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
    ...(bootstrap || isDemo
      ? {}
      : {
          queues: {
            producers: [
              {
                binding: "NOTIFICATIONS",
                queue: `${manifest.cloudflare.workerName}-notifications`,
              },
            ],
            consumers: [
              {
                queue: `${manifest.cloudflare.workerName}-notifications`,
                max_batch_size: 10,
                max_batch_timeout: 5,
                max_retries: 4,
              },
            ],
          },
        }),
    durable_objects: {
      bindings: [
        { name: "WorkbenchThreadChatAgent", class_name: "WorkbenchThreadChatAgent" },
        { name: "WorkbenchSessionAgent", class_name: "WorkbenchSessionAgent" },
      ],
    },
    migrations: [
      {
        tag: "v1-workbench-thread-chat-agent",
        new_sqlite_classes: ["WorkbenchThreadChatAgent"],
      },
      {
        tag: "v2-workbench-session-agent",
        new_sqlite_classes: ["WorkbenchSessionAgent"],
      },
    ],
  };
  writeFileSync(wranglerPath, `${JSON.stringify(wrangler, null, 2)}\n`, { mode: 0o600 });

  const flyPath = resolve(directory, "fly.toml");
  const fly = `app = "${manifest.fly.appName}"
primary_region = "fra"

[build]
dockerfile = "../../../Dockerfile.langgraph"

[env]
LANGGRAPH_PORT = "2024"
LANGGRAPH_UPSTREAM_URL = "http://127.0.0.1:2024"
OPENROUTER_APP_NAME = "operloom-${target}-runner"
OPENROUTER_MODEL = "deepseek/deepseek-v4-flash"
OPENROUTER_SITE_URL = "${manifest.fly.origin}"
WORKBENCH_CONFORMANCE_MODE = "${manifest.conformanceMode}"
WORKBENCH_CALLBACK_ORIGIN = "${manifest.cloudflare.origin}"
WORKBENCH_RELEASE_SHA = "${releaseSha}"

[http_service]
internal_port = 3000
force_https = true
auto_stop_machines = "stop"
auto_start_machines = true
min_machines_running = 0
processes = ["app"]

[[http_service.checks]]
interval = "15s"
timeout = "2s"
grace_period = "20s"
method = "GET"
path = "/health/live"

[vm]
cpu_kind = "shared"
cpus = 1
memory = "1gb"
`;
  writeFileSync(flyPath, fly, { mode: 0o600 });

  const deploymentPath = resolve(directory, "deployment.json");
  writeFileSync(
    deploymentPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        target,
        bootstrap,
        featureStage,
        web: manifest.web,
        workos: manifest.workos,
        requiredSecretEnvironmentVariables: manifest.secretEnvironmentVariables,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return { directory, wranglerPath, flyPath, deploymentPath, manifest };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const target = args[args.indexOf("--target") + 1];
  const featureStage = args[args.indexOf("--feature-stage") + 1] ?? "disabled";
  const bootstrap = args.includes("--bootstrap");
  if (!target || !isEnvironmentTarget(target)) {
    throw new Error(`--target must be one of ${environmentTargets.join("|")}`);
  }
  if (!featureStages.includes(featureStage as FeatureStage)) {
    throw new Error(`--feature-stage must be one of ${featureStages.join("|")}`);
  }
  const rendered = renderEnvironmentConfig(target, {
    bootstrap,
    featureStage: featureStage as FeatureStage,
  });
  console.log(
    `Rendered secret-free ${target} deployment configuration under ${rendered.directory}.`,
  );
}
