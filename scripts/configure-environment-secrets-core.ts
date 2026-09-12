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
    CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET: roleValues.facadeSigning,
    WORKBENCH_RUNNER_SIGNING_SECRET: roleValues.runnerSigning,
    WORKBENCH_CALLBACK_SIGNING_SECRET: roleValues.callbackSigning,
    WORKBENCH_AGENT_CONNECTION_SECRET: roleValues.agentConnection,
    WORKBENCH_OPERATOR_ALERT_SIGNING_SECRET: roleValues.operatorAlertSigning,
    LANGGRAPH_UPSTREAM_TOKEN: roleValues.langgraphProxy,
    WORKOS_API_KEY: roleValues.vault,
    OPENROUTER_API_KEY: roleValues.openrouter,
    SENTRY_DSN: observability.sentryDsn,
  },
  flySecrets: {
    WORKBENCH_RUNNER_SIGNING_SECRET: roleValues.runnerSigning,
    WORKBENCH_CALLBACK_SIGNING_SECRET: roleValues.callbackSigning,
    LANGGRAPH_PROXY_TOKEN: roleValues.langgraphProxy,
    OPENROUTER_API_KEY: roleValues.openrouter,
    SENTRY_DSN: observability.sentryDsn,
  },
  webSecrets: {
    CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET: roleValues.facadeSigning,
    WORKBENCH_OPERATOR_ALERT_SIGNING_SECRET: roleValues.operatorAlertSigning,
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
    CLOUDFLARE_CONTROL_PLANE_URL: manifest.cloudflare.origin,
    LANGGRAPH_API_URL: manifest.fly.origin,
    NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID: "agent",
    WORKBENCH_ENVIRONMENT: manifest.target,
    WORKBENCH_OPERATOR_ALERT_CONFORMANCE_MODE: String(manifest.target === "acceptance"),
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
