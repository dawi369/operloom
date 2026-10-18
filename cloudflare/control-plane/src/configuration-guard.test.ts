import { describe, expect, it } from "vitest";

import { configurationProblems, releaseFeatureConfigurationValid } from "./configuration-guard";
import type { Env } from "./types";

const base = {
  OPERLOOM_WORKOS_ISSUER: "https://api.workos.com/user_management/client_x",
  OPERLOOM_WORKOS_JWKS_URL: "https://api.workos.com/sso/jwks/client_x",
  OPERLOOM_WORKOS_ALLOWED_CLIENT_IDS: "client_x",
  OPENROUTER_API_KEY: "sk-test",
} as unknown as Env;
const codes = (env: Env) => configurationProblems(env).map((problem) => problem.code);

describe("configuration guard", () => {
  it("accepts a minimal production deployment", () => {
    expect(codes(base)).toEqual([]);
    expect(releaseFeatureConfigurationValid(base)).toBe(true);
  });

  it("names the missing variables for the core features", () => {
    const problems = configurationProblems({ OPERLOOM_WORKOS_ISSUER: "x" } as unknown as Env);
    expect(problems.map((problem) => [problem.code, problem.variables])).toEqual([
      [
        "auth_workos_incomplete",
        ["OPERLOOM_WORKOS_JWKS_URL", "OPERLOOM_WORKOS_ALLOWED_CLIENT_IDS"],
      ],
      ["model_provider_unconfigured", ["OPENROUTER_API_KEY"]],
    ]);
    expect(codes({ ...base, OPERLOOM_LOCAL_API_ENABLED: "true" } as Env)).toEqual([]);
    expect(codes({ OPERLOOM_LOCAL_API_ENABLED: "true", OPERLOOM_E2E_MODE: "true" } as Env)).toEqual(
      [],
    );
  });

  it("flags a Fly runner that would silently fall back to inline", () => {
    expect(codes({ ...base, OPERLOOM_RUNNER_TRANSPORT: "fly" } as Env)).toEqual([
      "runner_fly_incomplete",
    ]);
    expect(
      codes({
        ...base,
        OPERLOOM_RUNNER_TRANSPORT: "fly",
        OPERLOOM_RUNNER_URL: "https://runner.example",
        OPERLOOM_RUNNER_SIGNING_SECRET: "s",
      } as Env),
    ).toEqual([]);
  });

  it("checks provider-specific secrets only for the selected provider", () => {
    expect(codes({ ...base, OPERLOOM_EMAIL_PROVIDER: "resend" } as Env)).toEqual([
      "email_provider_resend_misconfigured",
    ]);
    expect(codes({ ...base, OPERLOOM_BILLING_PROVIDER: "stripe" } as Env)).toEqual([
      "billing_stripe_incomplete",
    ]);
    expect(codes({ ...base, OPERLOOM_BILLING_PROVIDER: "polar" } as Env)).toEqual([
      "billing_polar_incomplete",
    ]);
    expect(codes({ ...base, OPERLOOM_BILLING_PROVIDER: "manual" } as Env)).toEqual([]);
  });

  it("keeps the feature posture dependencies", () => {
    expect(codes({ ...base, OPERLOOM_CONNECTIONS_ENABLED: "true" } as Env)).toEqual([
      "connections_require_retained_data",
      "vault_not_configured",
    ]);
    expect(
      codes({
        ...base,
        OPERLOOM_PUSH_ENABLED: "true",
        OPERLOOM_RETAINED_DATA_ENABLED: "true",
      } as Env),
    ).toEqual(["push_requires_notifications_queue", "vault_not_configured"]);
    expect(
      codes({
        ...base,
        OPERLOOM_CONNECTIONS_ENABLED: "true",
        OPERLOOM_RETAINED_DATA_ENABLED: "true",
        OPERLOOM_VAULT_BACKEND: "memory",
      } as Env),
    ).toEqual(["vault_memory_backend_forbidden"]);
    expect(
      codes({
        ...base,
        OPERLOOM_CONNECTIONS_ENABLED: "true",
        OPERLOOM_RETAINED_DATA_ENABLED: "true",
        OPERLOOM_VAULT_BACKEND: "memory",
        OPERLOOM_E2E_MODE: "true",
      } as Env),
    ).toEqual([]);
  });

  it("never includes variable values", () => {
    const serialized = JSON.stringify(
      configurationProblems({
        ...base,
        OPERLOOM_EMAIL_PROVIDER: "resend",
        RESEND_API_KEY: "",
      } as Env),
    );
    expect(serialized).not.toContain("sk-test");
  });
});
