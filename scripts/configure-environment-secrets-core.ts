import type { WorkbenchEnvironment } from "./workbench-environment";

export type HostedSecretRoleValues = Record<
  keyof WorkbenchEnvironment["secretEnvironmentVariables"],
  string
>;
export type HostedObservabilityValues = {
  sentryDsn: string;
  sentryAuthToken: string;
};

export const buildProviderSecretConfiguration = (
  manifest: WorkbenchEnvironment,
  roleValues: HostedSecretRoleValues,
  observability: HostedObservabilityValues,
) => ({
  workerSecrets: {
    OPERLOOM_RUNNER_SIGNING_SECRET: roleValues.runnerSigning,
    OPERLOOM_CALLBACK_SIGNING_SECRET: roleValues.callbackSigning,
    OPERLOOM_AGENT_CONNECTION_SECRET: roleValues.agentConnection,
    OPERLOOM_OPERATOR_ALERT_SIGNING_SECRET: roleValues.operatorAlertSigning,
    WORKOS_API_KEY: roleValues.vault,
    OPENROUTER_API_KEY: roleValues.openrouter,
    SENTRY_DSN: observability.sentryDsn,
  },
  flySecrets: {
    OPERLOOM_RUNNER_SIGNING_SECRET: roleValues.runnerSigning,
    OPERLOOM_CALLBACK_SIGNING_SECRET: roleValues.callbackSigning,
    SENTRY_DSN: observability.sentryDsn,
  },
  webSecrets: {
    OPERLOOM_OPERATOR_ALERT_SIGNING_SECRET: roleValues.operatorAlertSigning,
    WORKOS_API_KEY: roleValues.vault,
    WORKOS_COOKIE_PASSWORD: roleValues.workosCookie,
    SENTRY_DSN: observability.sentryDsn,
    NEXT_PUBLIC_SENTRY_DSN: observability.sentryDsn,
    SENTRY_AUTH_TOKEN: observability.sentryAuthToken,
  },
  webVariables: {
    WORKOS_CLIENT_ID: manifest.workos.applicationId,
    NEXT_PUBLIC_WORKOS_CLIENT_ID: manifest.workos.applicationId,
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: `${manifest.web.origin}/auth/callback`,
    OPERLOOM_BACKEND_URL: manifest.cloudflare.origin,
    OPERLOOM_ENVIRONMENT: manifest.target,
    OPERLOOM_OPERATOR_ALERT_CONFORMANCE_MODE: String(manifest.target === "acceptance"),
    SENTRY_ORG: "t23",
    SENTRY_PROJECT: "operloom",
    SENTRY_ENVIRONMENT: manifest.target,
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: manifest.target,
    SENTRY_TRACES_SAMPLE_RATE: manifest.target === "demo" ? "0" : "0.02",
    NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: manifest.target === "demo" ? "0" : "0.02",
    NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE: "0",
    NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE: "0",
  },
});
