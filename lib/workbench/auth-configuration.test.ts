import { describe, expect, it } from "vitest";
import { getAuthConfiguration, getWorkOSBaseURL } from "./auth-configuration";

const local = { NODE_ENV: "development", WORKBENCH_ALLOW_LOCAL_DEV_IDENTITY: "true" };

describe("local authentication configuration", () => {
  it("allows explicitly opted-in development without a hosted account", () => {
    expect(getAuthConfiguration(local)).toEqual({
      workOsConfigured: false,
      localIdentityEnabled: true,
    });
  });
  it.each([
    {},
    { NODE_ENV: "production" },
    { NODE_ENV: "test" },
    { NODE_ENV: "development", WORKBENCH_ALLOW_LOCAL_DEV_IDENTITY: "false" },
    { ...local, NODE_ENV: "production" },
    { ...local, VERCEL_ENV: "preview" },
    { ...local, VERCEL_ENV: "production" },
    { ...local, FLY_APP_NAME: "deployed-app" },
  ])("never enables the local identity outside explicit local development: %j", (environment) => {
    expect(getAuthConfiguration(environment).localIdentityEnabled).toBe(false);
  });
  it("keeps configured WorkOS authoritative even when the local flag is present", () => {
    expect(
      getAuthConfiguration({
        ...local,
        WORKOS_CLIENT_ID: "client_fixture",
        WORKOS_API_KEY: "fixture-key",
        WORKOS_COOKIE_PASSWORD: "fixture-cookie-password-that-is-long-enough",
        NEXT_PUBLIC_WORKOS_REDIRECT_URI: "http://localhost:3000/auth/callback",
      }),
    ).toEqual({ workOsConfigured: true, localIdentityEnabled: false });
  });
});

describe("WorkOS public callback origin", () => {
  it("pins hosted callback redirects to the configured public origin", () => {
    expect(
      getWorkOSBaseURL({
        NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://operloom.t23.dev/auth/callback",
        HOSTNAME: "0.0.0.0",
      }),
    ).toBe("https://operloom.t23.dev");
  });

  it("lets the SDK infer the origin when WorkOS is not configured", () => {
    expect(getWorkOSBaseURL({})).toBeUndefined();
  });
});
