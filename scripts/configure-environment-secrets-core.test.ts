import { describe, expect, it } from "vitest";

import {
  buildProviderSecretConfiguration,
  type HostedSecretRoleValues,
} from "./configure-environment-secrets-core";
import { loadWorkbenchEnvironment, resolveEnvironmentReferences } from "./workbench-environment";

describe("provider secret configuration", () => {
  it("uses resolved target metadata and keeps secret roles at provider boundaries", () => {
    const source = {
      WORKBENCH_ACCEPTANCE_D1_DATABASE_ID: "11111111-1111-4111-8111-111111111111",
      WORKBENCH_ACCEPTANCE_CLOUDFLARE_ORIGIN: "https://control.acceptance.example.test",
      WORKBENCH_ACCEPTANCE_FLY_ORIGIN: "https://runner.acceptance.example.test",
      WORKBENCH_ACCEPTANCE_VERCEL_ORG_ID: "team_acceptance",
      WORKBENCH_ACCEPTANCE_VERCEL_PROJECT_ID: "project_acceptance",
      WORKBENCH_ACCEPTANCE_WEB_ORIGIN: "https://workbench.acceptance.example.test",
      WORKBENCH_ACCEPTANCE_WORKOS_APPLICATION_ID: "client_acceptance",
      WORKBENCH_ACCEPTANCE_WORKSPACE_ID: "workspace_acceptance",
    } as unknown as NodeJS.ProcessEnv;
    const resolved = resolveEnvironmentReferences(loadWorkbenchEnvironment("acceptance"), source);
    expect(resolved.unresolved).toEqual([]);
    const roles = Object.fromEntries(
      Object.keys(loadWorkbenchEnvironment("acceptance").secretEnvironmentVariables).map((role) => [
        role,
        `${role}-${"x".repeat(40)}`,
      ]),
    ) as HostedSecretRoleValues;

    const configuration = buildProviderSecretConfiguration(resolved.manifest, roles, {
      sentryDsn: "https://public@example.ingest.sentry.io/1",
      sentryAuthToken: `sentry-${"x".repeat(40)}`,
    });

    expect(configuration.webVariables).toMatchObject({
      WORKOS_CLIENT_ID: "client_acceptance",
      NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://workbench.acceptance.example.test/auth/callback",
      CLOUDFLARE_CONTROL_PLANE_URL: "https://control.acceptance.example.test",
      LANGGRAPH_API_URL: "https://runner.acceptance.example.test",
    });
    expect(JSON.stringify(configuration.webVariables)).not.toContain("${");
    expect(configuration.flySecrets).not.toHaveProperty("WORKOS_API_KEY");
    expect(configuration.webSecrets).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(configuration.workerSecrets.WORKOS_API_KEY).toBe(roles.vault);
    expect(configuration.workerSecrets).toHaveProperty("SENTRY_DSN");
    expect(configuration.flySecrets).toHaveProperty("SENTRY_DSN");
    expect(configuration.webSecrets).toHaveProperty("SENTRY_AUTH_TOKEN");
  });
});
