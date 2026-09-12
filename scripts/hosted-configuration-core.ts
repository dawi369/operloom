import type { EnvironmentTarget, WorkbenchEnvironment } from "./workbench-environment";

export type HostedService = "web" | "cloudflare" | "fly";
export type HostedVariableInventory = Record<HostedService, ReadonlyMap<string, string | null>>;

const commonForbidden = [
  "CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN",
  "WORKBENCH_ALLOW_LOCAL_DEV_IDENTITY",
  "WORKBENCH_DEV_USER_ID",
  "WORKBENCH_DEV_WORKSPACE_ID",
  "WORKBENCH_EXECUTOR_TOKEN",
  "WORKBENCH_EXECUTOR_URL",
  "WORKBENCH_SHARED_SECRET",
  "WORKBENCH_LOCAL_IDENTITY",
] as const;

export const hostedEnvironmentPolicy = (target: EnvironmentTarget) => {
  const conformance = target === "acceptance";
  const demo = target === "demo";
  return {
    web: {
      required: [
        "CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET",
        "WORKBENCH_OPERATOR_ALERT_SIGNING_SECRET",
        "WORKOS_API_KEY",
        "WORKOS_COOKIE_PASSWORD",
        "WORKOS_CLIENT_ID",
        "NEXT_PUBLIC_WORKOS_CLIENT_ID",
        "NEXT_PUBLIC_WORKOS_REDIRECT_URI",
        "CLOUDFLARE_CONTROL_PLANE_URL",
        "LANGGRAPH_API_URL",
        "NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID",
        "WORKBENCH_ENVIRONMENT",
        "WORKBENCH_OPERATOR_ALERT_CONFORMANCE_MODE",
        "SENTRY_DSN",
        "NEXT_PUBLIC_SENTRY_DSN",
        "SENTRY_AUTH_TOKEN",
      ],
      optional: [
        "WORKBENCH_ADMIN_EMAILS",
        "SENTRY_ORG",
        "SENTRY_PROJECT",
        "SENTRY_ENVIRONMENT",
        "NEXT_PUBLIC_SENTRY_ENVIRONMENT",
        "SENTRY_TRACES_SAMPLE_RATE",
        "NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE",
        "NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE",
        "NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE",
      ],
      forbidden: [...commonForbidden, "WORKBENCH_VAULT_BACKEND", "WORKBENCH_CONFORMANCE_MODE"],
    },
    cloudflare: {
      required: [
        "CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET",
        "WORKBENCH_RUNNER_SIGNING_SECRET",
        "WORKBENCH_CALLBACK_SIGNING_SECRET",
        "WORKBENCH_AGENT_CONNECTION_SECRET",
        "WORKBENCH_OPERATOR_ALERT_SIGNING_SECRET",
        "LANGGRAPH_UPSTREAM_TOKEN",
        "WORKOS_API_KEY",
        "OPENROUTER_API_KEY",
        "SENTRY_DSN",
        "WORKBENCH_VAULT_BACKEND",
        "WORKBENCH_CONFORMANCE_MODE",
        "WORKBENCH_RETAINED_DATA_ENABLED",
        "WORKBENCH_CONNECTIONS_ENABLED",
        "WORKBENCH_MUTATIONS_ENABLED",
        "WORKBENCH_PUSH_ENABLED",
        "WORKBENCH_RELEASE_SHA",
        ...(demo
          ? [
              "WORKBENCH_DEMO_MODE",
              "WORKBENCH_DEMO_PACK_ALLOWLIST",
              "WORKBENCH_DEMO_CHAT_DAILY_LIMIT",
              "WORKBENCH_DEMO_WORKFLOW_DAILY_LIMIT",
              "WORKBENCH_DEMO_MODEL_BUDGET_USD",
              "WORKBENCH_DEMO_ARTIFACT_WORKSPACE_BYTES",
              "WORKBENCH_DEMO_RETENTION_DAYS",
            ]
          : []),
      ],
      optional: ["SENTRY_ENVIRONMENT", "SENTRY_TRACES_SAMPLE_RATE"],
      forbidden: [...commonForbidden],
    },
    fly: {
      required: [
        "WORKBENCH_RUNNER_SIGNING_SECRET",
        "WORKBENCH_CALLBACK_SIGNING_SECRET",
        "LANGGRAPH_PROXY_TOKEN",
        "OPENROUTER_API_KEY",
        "SENTRY_DSN",
        "WORKBENCH_CONFORMANCE_MODE",
        "WORKBENCH_RELEASE_SHA",
      ],
      optional: ["SENTRY_ENVIRONMENT", "SENTRY_TRACES_SAMPLE_RATE"],
      forbidden: [...commonForbidden, "WORKOS_API_KEY", "WORKBENCH_VAULT_BACKEND"],
    },
    expected: {
      conformance: String(conformance),
      retainedData: "true",
      connections: String(!demo),
      mutations: String(conformance && !demo),
      push: "false",
      vaultBackend: target === "local" ? "memory" : "workos",
    },
  } as const;
};

export const parseVercelEnvironmentInventory = (output: string) => {
  const names = new Map<string, string | null>();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^([A-Z][A-Z0-9_]*)\s+(?:Encrypted|Plaintext)/);
    if (match?.[1]) names.set(match[1], null);
  }
  return names;
};

export const parseRailwayEnvironmentInventory = (output: string) => {
  const parsed = JSON.parse(output) as Record<string, unknown>;
  return new Map(
    Object.entries(parsed)
      .filter(([name]) => /^[A-Z][A-Z0-9_]*$/.test(name))
      .map(([name, value]) => [name, typeof value === "string" ? value : null] as const),
  );
};

export const parseCloudflareEnvironmentInventory = (output: string) => {
  const parsed = JSON.parse(output) as { resources?: { bindings?: unknown[] } };
  const names = new Map<string, string | null>();
  for (const raw of parsed.resources?.bindings ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const binding = raw as { name?: unknown; type?: unknown; text?: unknown };
    if (typeof binding.name !== "string") continue;
    if (binding.type === "secret_text") names.set(binding.name, null);
    else if (binding.type === "plain_text" && typeof binding.text === "string") {
      names.set(binding.name, binding.text);
    }
  }
  return names;
};

export const parseFlyEnvironmentInventory = (config: string, secrets: string) => {
  const names = new Map<string, string | null>();
  let inEnv = false;
  for (const line of config.split("\n")) {
    if (/^\[env\]\s*$/.test(line.trim())) {
      inEnv = true;
      continue;
    }
    if (inEnv && line.trim().startsWith("[")) inEnv = false;
    if (!inEnv) continue;
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*['"](.*)['"]\s*$/);
    if (match?.[1]) names.set(match[1], match[2] ?? "");
  }
  const secretList = JSON.parse(secrets) as { name?: unknown }[];
  for (const secret of secretList) {
    if (typeof secret.name === "string") names.set(secret.name, null);
  }
  return names;
};

export const validateHostedConfiguration = (
  manifest: WorkbenchEnvironment,
  inventory: HostedVariableInventory,
  expectedCommit: string,
) => {
  const policy = hostedEnvironmentPolicy(manifest.target);
  const failures: string[] = [];
  for (const service of ["web", "cloudflare", "fly"] as const) {
    for (const name of policy[service].required) {
      if (!inventory[service].has(name)) failures.push(`${service} is missing ${name}`);
    }
    for (const name of policy[service].forbidden) {
      if (inventory[service].has(name)) failures.push(`${service} contains forbidden ${name}`);
    }
  }
  const requireValue = (service: HostedService, name: string, value: string) => {
    const actual = inventory[service].get(name);
    if (actual === null && service === "web") return;
    if (actual !== value) failures.push(`${service} ${name} does not match the manifest policy`);
  };
  requireValue("cloudflare", "WORKBENCH_VAULT_BACKEND", policy.expected.vaultBackend);
  requireValue("cloudflare", "WORKBENCH_CONFORMANCE_MODE", policy.expected.conformance);
  requireValue("cloudflare", "WORKBENCH_RETAINED_DATA_ENABLED", policy.expected.retainedData);
  requireValue("cloudflare", "WORKBENCH_CONNECTIONS_ENABLED", policy.expected.connections);
  requireValue("cloudflare", "WORKBENCH_MUTATIONS_ENABLED", policy.expected.mutations);
  requireValue("cloudflare", "WORKBENCH_PUSH_ENABLED", policy.expected.push);
  requireValue("cloudflare", "WORKBENCH_RELEASE_SHA", expectedCommit);
  requireValue("fly", "WORKBENCH_CONFORMANCE_MODE", policy.expected.conformance);
  requireValue("fly", "WORKBENCH_RELEASE_SHA", expectedCommit);
  requireValue("web", "WORKBENCH_ENVIRONMENT", manifest.target);
  requireValue("web", "WORKBENCH_OPERATOR_ALERT_CONFORMANCE_MODE", policy.expected.conformance);
  requireValue("web", "CLOUDFLARE_CONTROL_PLANE_URL", manifest.cloudflare.origin);
  requireValue("web", "LANGGRAPH_API_URL", manifest.fly.origin);
  requireValue("web", "NEXT_PUBLIC_WORKOS_REDIRECT_URI", `${manifest.web.origin}/auth/callback`);
  return failures;
};
