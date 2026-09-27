import { isRecord } from "./http";
import type { Env } from "./types";

export type ConnectionProvider = {
  id: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  revocationUrl?: string;
  actionUrl?: string;
  clientId?: string;
  clientSecret?: string;
  permittedHosts: readonly string[];
  credentialPlacement: "bearer" | "x-api-key";
};

const validEndpoint = (env: Env, value: unknown) => {
  if (typeof value !== "string") return undefined;
  const url = new URL(value);
  const e2eLocal =
    env.OPERLOOM_E2E_MODE === "true" &&
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !e2eLocal) throw new Error("provider_endpoint_not_https");
  if (url.username || url.password) throw new Error("provider_endpoint_credentials_forbidden");
  return url.toString();
};

export const connectionProviderRegistry = (env: Env): ReadonlyMap<string, ConnectionProvider> => {
  if (!env.OPERLOOM_OAUTH_PROVIDERS_JSON?.trim()) return new Map();
  const parsed = JSON.parse(env.OPERLOOM_OAUTH_PROVIDERS_JSON) as unknown;
  if (!Array.isArray(parsed)) throw new Error("connection_provider_registry_invalid");
  const entries = parsed.map((raw): [string, ConnectionProvider] => {
    if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id.trim()) {
      throw new Error("connection_provider_registry_invalid");
    }
    const permittedHosts = Array.isArray(raw.permittedHosts)
      ? raw.permittedHosts
          .filter((host): host is string => typeof host === "string" && /^[a-z0-9.-]+$/i.test(host))
          .map((host) => host.toLowerCase())
      : [];
    const provider: ConnectionProvider = {
      id: raw.id,
      authorizationUrl: validEndpoint(env, raw.authorizationUrl),
      tokenUrl: validEndpoint(env, raw.tokenUrl),
      revocationUrl: validEndpoint(env, raw.revocationUrl),
      actionUrl: validEndpoint(
        env,
        raw.actionUrl ??
          (env.OPERLOOM_E2E_MODE === "true" && raw.id === "synthetic-broker"
            ? "http://127.0.0.1:3101/e2e/actions"
            : undefined),
      ),
      clientId: typeof raw.clientId === "string" ? raw.clientId : undefined,
      clientSecret: typeof raw.clientSecret === "string" ? raw.clientSecret : undefined,
      permittedHosts,
      credentialPlacement: raw.credentialPlacement === "x-api-key" ? "x-api-key" : "bearer",
    };
    for (const endpoint of [
      provider.authorizationUrl,
      provider.tokenUrl,
      provider.revocationUrl,
      provider.actionUrl,
    ]) {
      if (endpoint && !permittedHosts.includes(new URL(endpoint).hostname.toLowerCase())) {
        throw new Error("provider_endpoint_host_not_permitted");
      }
    }
    return [provider.id, provider];
  });
  const registry = new Map(entries);
  if (registry.size !== entries.length) throw new Error("connection_provider_registry_duplicate");
  return registry;
};

export const requireConnectionProvider = (env: Env, providerId: string) => {
  const provider = connectionProviderRegistry(env).get(providerId);
  if (!provider) throw new Error("connection_provider_not_configured");
  return provider;
};

export const assertProviderRequest = (
  env: Env,
  provider: ConnectionProvider,
  rawUrl: string,
  method = "GET",
) => {
  const url = new URL(rawUrl);
  const e2eLocal =
    env.OPERLOOM_E2E_MODE === "true" &&
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !e2eLocal) throw new Error("provider_request_not_https");
  if (!provider.permittedHosts.includes(url.hostname.toLowerCase())) {
    throw new Error("provider_host_not_permitted");
  }
  const normalizedMethod = method.toUpperCase();
  if (!new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]).has(normalizedMethod)) {
    throw new Error("provider_method_not_permitted");
  }
  return { url, method: normalizedMethod };
};
