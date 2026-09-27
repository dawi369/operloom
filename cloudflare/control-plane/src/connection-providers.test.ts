import { describe, expect, it } from "vitest";

import { assertProviderRequest, connectionProviderRegistry } from "./connection-providers";
import type { Env } from "./types";

describe("connection provider registry", () => {
  it("accepts HTTPS provider modules and enforces outbound hosts", () => {
    const env = {
      OPERLOOM_OAUTH_PROVIDERS_JSON: JSON.stringify([
        {
          id: "broker",
          authorizationUrl: "https://auth.broker.test/authorize",
          tokenUrl: "https://auth.broker.test/token",
          actionUrl: "https://api.broker.test/actions",
          clientId: "public-client",
          permittedHosts: ["auth.broker.test", "api.broker.test"],
        },
      ]),
    } as Env;
    const provider = connectionProviderRegistry(env).get("broker");
    expect(provider?.clientId).toBe("public-client");
    expect(provider?.actionUrl).toBe("https://api.broker.test/actions");
    expect(
      assertProviderRequest(env, provider!, "https://api.broker.test/orders", "POST"),
    ).toMatchObject({ method: "POST" });
    expect(() =>
      assertProviderRequest(env, provider!, "https://metadata.google.internal", "GET"),
    ).toThrow("provider_host_not_permitted");
  });

  it("rejects plaintext endpoints outside explicit E2E mode", () => {
    const env = {
      OPERLOOM_OAUTH_PROVIDERS_JSON: JSON.stringify([
        {
          id: "broker",
          tokenUrl: "http://127.0.0.1:9999/token",
          permittedHosts: ["127.0.0.1"],
        },
      ]),
    } as Env;
    expect(() => connectionProviderRegistry(env)).toThrow("provider_endpoint_not_https");
    expect(() => connectionProviderRegistry({ ...env, OPERLOOM_E2E_MODE: "true" })).not.toThrow();
  });
});
