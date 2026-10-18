import type { Env } from "./types";
import { demoConfigurationValid } from "./demo-policy";
import {
  connectionsEnabled,
  mutationsEnabled,
  pushEnabled,
  retainedDataEnabled,
} from "./feature-gates";

/**
 * One thing that is switched on but cannot work with the variables present.
 * `variables` are names only; values never leave the Worker.
 */
export type ConfigurationProblem = {
  code: string;
  feature: string;
  variables: string[];
  message: string;
};

const present = (value: string | undefined) => Boolean(value?.trim());
const e2e = (env: Env) => env.OPERLOOM_E2E_MODE === "true";

/**
 * Every enabled feature whose required variables are missing, plus the posture
 * dependencies between features. Empty means the deployment is consistent.
 */
export const configurationProblems = (env: Env): ConfigurationProblem[] => {
  const problems: ConfigurationProblem[] = [];
  const missing = (feature: string, code: string, required: Array<keyof Env & string>) => {
    const absent = required.filter((name) => !present(env[name] as string | undefined));
    if (absent.length)
      problems.push({
        code,
        feature,
        variables: absent,
        message: `${feature} is enabled but ${absent.join(", ")} ${absent.length === 1 ? "is" : "are"} not set.`,
      });
  };
  const posture = {
    retainedData: retainedDataEnabled(env),
    connections: connectionsEnabled(env),
    mutations: mutationsEnabled(env),
    push: pushEnabled(env),
  };

  if (!demoConfigurationValid(env))
    problems.push({
      code: "demo_configuration_invalid",
      feature: "demo mode",
      variables: ["OPERLOOM_DEMO_MODE", "OPERLOOM_DEMO_PACK_ALLOWLIST"],
      message: "Demo mode is enabled but its limits or pack allowlist are invalid.",
    });
  if (env.OPERLOOM_LOCAL_API_ENABLED !== "true")
    missing("WorkOS authentication", "auth_workos_incomplete", [
      "OPERLOOM_WORKOS_ISSUER",
      "OPERLOOM_WORKOS_JWKS_URL",
      "OPERLOOM_WORKOS_ALLOWED_CLIENT_IDS",
    ]);
  if (!e2e(env)) missing("model provider", "model_provider_unconfigured", ["OPENROUTER_API_KEY"]);
  if (posture.connections && !posture.retainedData)
    problems.push({
      code: "connections_require_retained_data",
      feature: "connections",
      variables: ["OPERLOOM_RETAINED_DATA_ENABLED"],
      message: "Connections need retained data; set OPERLOOM_RETAINED_DATA_ENABLED=true.",
    });
  if (posture.mutations && (!posture.connections || !posture.retainedData))
    problems.push({
      code: "mutations_require_connections",
      feature: "mutations",
      variables: ["OPERLOOM_CONNECTIONS_ENABLED", "OPERLOOM_RETAINED_DATA_ENABLED"],
      message: "Mutations need connections and retained data enabled.",
    });
  if (posture.push && !posture.retainedData)
    problems.push({
      code: "push_requires_retained_data",
      feature: "push",
      variables: ["OPERLOOM_RETAINED_DATA_ENABLED"],
      message: "Push needs retained data; set OPERLOOM_RETAINED_DATA_ENABLED=true.",
    });
  if (posture.push && !env.NOTIFICATIONS)
    problems.push({
      code: "push_requires_notifications_queue",
      feature: "push",
      variables: ["NOTIFICATIONS"],
      message: "Push is enabled but the NOTIFICATIONS queue binding is missing.",
    });
  if (posture.connections || posture.push) {
    if (env.OPERLOOM_VAULT_BACKEND === "memory") {
      if (!e2e(env))
        problems.push({
          code: "vault_memory_backend_forbidden",
          feature: "credential vault",
          variables: ["OPERLOOM_VAULT_BACKEND"],
          message: "The memory vault backend is only allowed with OPERLOOM_E2E_MODE=true.",
        });
    } else missing("credential vault", "vault_not_configured", ["WORKOS_API_KEY"]);
  }
  if (env.OPERLOOM_RUNNER_TRANSPORT === "fly")
    missing("Fly runner", "runner_fly_incomplete", [
      "OPERLOOM_RUNNER_URL",
      "OPERLOOM_RUNNER_SIGNING_SECRET",
    ]);
  if (env.OPERLOOM_EMAIL_PROVIDER?.trim() === "resend")
    missing("Resend email", "email_provider_resend_misconfigured", [
      "RESEND_API_KEY",
      "OPERLOOM_EMAIL_FROM",
    ]);
  if (present(env.OPERLOOM_NOTIFICATION_RELAY_URL))
    missing("notification relay", "notification_relay_incomplete", [
      "OPERLOOM_NOTIFICATION_RELAY_SECRET",
    ]);
  if (present(env.OPERLOOM_OPERATOR_ALERT_WEBHOOK_URL))
    missing("operator alerts", "operator_alerts_incomplete", [
      "OPERLOOM_OPERATOR_ALERT_SIGNING_SECRET",
    ]);
  switch (env.OPERLOOM_BILLING_PROVIDER?.trim()) {
    case "stripe":
      missing("Stripe billing", "billing_stripe_incomplete", [
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
      ]);
      break;
    case "polar":
      missing("Polar billing", "billing_polar_incomplete", [
        "POLAR_ACCESS_TOKEN",
        "POLAR_WEBHOOK_SECRET",
      ]);
      break;
    default:
      break;
  }
  return problems;
};

/** True when nothing enabled is missing its variables; `/health` reports the list behind this. */
export const releaseFeatureConfigurationValid = (env: Env) =>
  configurationProblems(env).length === 0;

const reported = new WeakSet<object>();

/** Logs the problem list once per isolate so a misconfigured deploy is visible in the Worker logs, not only on /health. */
export const reportConfigurationProblemsOnce = (env: Env) => {
  if (reported.has(env)) return;
  reported.add(env);
  const problems = configurationProblems(env);
  if (!problems.length) return;
  console.error(
    JSON.stringify({
      event: "configuration.problems",
      count: problems.length,
      problems: problems.map(({ code, feature, variables }) => ({ code, feature, variables })),
    }),
  );
};
