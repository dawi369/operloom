import type { EnvironmentTarget, WorkbenchEnvironment } from "./workbench-environment";

export type HostedService = "web" | "cloudflare" | "fly";
export type HostedVariableInventory = Record<HostedService, ReadonlyMap<string, string | null>>;

const commonForbidden = [
  "OPERLOOM_LOCAL_API_TOKEN",
  "OPERLOOM_LOCAL_API_ENABLED",
  "OPERLOOM_LOCAL_API_USER_ID",
  "OPERLOOM_EXECUTOR_TOKEN",
  "OPERLOOM_EXECUTOR_URL",
  "OPERLOOM_SHARED_SECRET",
  "OPERLOOM_LOCAL_IDENTITY",
] as const;

export const hostedEnvironmentPolicy = (target: EnvironmentTarget) => {
  const conformance = target === "acceptance";
  const demo = target === "demo";
  return {
    web: {
      required: [
        "OPERLOOM_OPERATOR_ALERT_SIGNING_SECRET",
        "WORKOS_API_KEY",
        "WORKOS_COOKIE_PASSWORD",
        "WORKOS_CLIENT_ID",
        "NEXT_PUBLIC_WORKOS_CLIENT_ID",
        "NEXT_PUBLIC_WORKOS_REDIRECT_URI",
        "OPERLOOM_BACKEND_URL",
        "OPERLOOM_ENVIRONMENT",
        "OPERLOOM_OPERATOR_ALERT_CONFORMANCE_MODE",
        "SENTRY_DSN",
        "NEXT_PUBLIC_SENTRY_DSN",
        "SENTRY_AUTH_TOKEN",
      ],
      optional: [
        "OPERLOOM_ADMIN_EMAILS",
        "SENTRY_ORG",
        "SENTRY_PROJECT",
        "SENTRY_ENVIRONMENT",
        "NEXT_PUBLIC_SENTRY_ENVIRONMENT",
        "SENTRY_TRACES_SAMPLE_RATE",
        "NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE",
        "NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE",
        "NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE",
      ],
      forbidden: [...commonForbidden, "OPERLOOM_VAULT_BACKEND", "OPERLOOM_CONFORMANCE_MODE"],
    },
    cloudflare: {
      required: [
        "OPERLOOM_RUNNER_SIGNING_SECRET",
        "OPERLOOM_CALLBACK_SIGNING_SECRET",
        "OPERLOOM_AGENT_CONNECTION_SECRET",
        "OPERLOOM_OPERATOR_ALERT_SIGNING_SECRET",
        "WORKOS_API_KEY",
        "OPENROUTER_API_KEY",
        "SENTRY_DSN",
        "OPERLOOM_VAULT_BACKEND",
        "OPERLOOM_CONFORMANCE_MODE",
        "OPERLOOM_RETAINED_DATA_ENABLED",
        "OPERLOOM_CONNECTIONS_ENABLED",
        "OPERLOOM_MUTATIONS_ENABLED",
        "OPERLOOM_PUSH_ENABLED",
        "OPERLOOM_RELEASE_SHA",
        ...(demo
          ? [
              "OPERLOOM_DEMO_MODE",
              "OPERLOOM_DEMO_PACK_ALLOWLIST",
              "OPERLOOM_DEMO_CHAT_DAILY_LIMIT",
              "OPERLOOM_DEMO_WORKFLOW_DAILY_LIMIT",
              "OPERLOOM_DEMO_MODEL_BUDGET_USD",
              "OPERLOOM_DEMO_ARTIFACT_WORKSPACE_BYTES",
              "OPERLOOM_DEMO_RETENTION_DAYS",
            ]
          : []),
      ],
      optional: ["SENTRY_ENVIRONMENT", "SENTRY_TRACES_SAMPLE_RATE"],
      forbidden: [...commonForbidden],
    },
    fly: {
      required: [
        "OPERLOOM_RUNNER_SIGNING_SECRET",
        "OPERLOOM_CALLBACK_SIGNING_SECRET",
        "SENTRY_DSN",
        "OPERLOOM_CONFORMANCE_MODE",
        "OPERLOOM_RELEASE_SHA",
      ],
      optional: ["SENTRY_ENVIRONMENT", "SENTRY_TRACES_SAMPLE_RATE"],
      forbidden: [...commonForbidden, "WORKOS_API_KEY", "OPERLOOM_VAULT_BACKEND"],
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
  requireValue("cloudflare", "OPERLOOM_VAULT_BACKEND", policy.expected.vaultBackend);
  requireValue("cloudflare", "OPERLOOM_CONFORMANCE_MODE", policy.expected.conformance);
  requireValue("cloudflare", "OPERLOOM_RETAINED_DATA_ENABLED", policy.expected.retainedData);
  requireValue("cloudflare", "OPERLOOM_CONNECTIONS_ENABLED", policy.expected.connections);
  requireValue("cloudflare", "OPERLOOM_MUTATIONS_ENABLED", policy.expected.mutations);
  requireValue("cloudflare", "OPERLOOM_PUSH_ENABLED", policy.expected.push);
  requireValue("cloudflare", "OPERLOOM_RELEASE_SHA", expectedCommit);
  requireValue("fly", "OPERLOOM_CONFORMANCE_MODE", policy.expected.conformance);
  requireValue("fly", "OPERLOOM_RELEASE_SHA", expectedCommit);
  requireValue("web", "OPERLOOM_ENVIRONMENT", manifest.target);
  requireValue("web", "OPERLOOM_OPERATOR_ALERT_CONFORMANCE_MODE", policy.expected.conformance);
  requireValue("web", "OPERLOOM_BACKEND_URL", manifest.cloudflare.origin);
  requireValue("web", "NEXT_PUBLIC_WORKOS_REDIRECT_URI", `${manifest.web.origin}/auth/callback`);
  return failures;
};
