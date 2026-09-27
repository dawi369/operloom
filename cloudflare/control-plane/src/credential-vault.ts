import { connectionsEnabled, pushEnabled } from "./feature-gates";
import type { Env } from "./types";

export type VaultContext = {
  workspaceId: string;
};

export type VaultObjectReference = {
  id: string;
  version: string;
};

export type CredentialVault = {
  create(input: {
    context: VaultContext;
    name: string;
    value: string;
  }): Promise<VaultObjectReference>;
  read(input: VaultObjectReference): Promise<{ value: string; version: string }>;
  replace(input: VaultObjectReference & { value: string }): Promise<VaultObjectReference>;
  revoke(input: VaultObjectReference): Promise<void>;
  delete(input: VaultObjectReference): Promise<void>;
};

type WorkOSVaultResponse = {
  id?: string;
  value?: string;
  version_id?: string;
  metadata?: { version_id?: string };
  success?: boolean;
};

const requiredString = (value: unknown, name: string) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`vault_invalid_${name}`);
  return value;
};

const workspaceKeyContext = async (workspaceId: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(workspaceId));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const workosRequest = async (
  env: Env,
  path: string,
  init: RequestInit,
): Promise<WorkOSVaultResponse> => {
  const apiKey = env.WORKOS_API_KEY?.trim();
  if (!apiKey) throw new Error("vault_not_configured");
  const base = (env.WORKOS_VAULT_API_URL ?? "https://api.workos.com").replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(response.status === 409 ? "vault_version_conflict" : "vault_request_failed");
  }
  return (await response.json().catch(() => ({}))) as WorkOSVaultResponse;
};

export const createWorkOSCredentialVault = (env: Env): CredentialVault => ({
  async create(input) {
    const workspaceContext = await workspaceKeyContext(input.context.workspaceId);
    const response = await workosRequest(env, "/vault/v1/kv", {
      method: "POST",
      body: JSON.stringify({
        // Canonical workspace IDs contain separators WorkOS key-context
        // values reject. A stable digest preserves per-workspace key isolation
        // without exposing the tenant identifier in key metadata.
        key_context: { workspace_id: workspaceContext },
        name: `${input.context.workspaceId}:${input.name}`,
        value: input.value,
      }),
    });
    return {
      id: requiredString(response.id, "id"),
      version: requiredString(response.version_id ?? response.metadata?.version_id, "version"),
    };
  },
  async read(input) {
    const response = await workosRequest(env, `/vault/v1/kv/${encodeURIComponent(input.id)}`, {
      method: "GET",
    });
    return {
      value: requiredString(response.value, "value"),
      version: requiredString(response.metadata?.version_id ?? response.version_id, "version"),
    };
  },
  async replace(input) {
    const response = await workosRequest(env, `/vault/v1/kv/${encodeURIComponent(input.id)}`, {
      method: "PUT",
      body: JSON.stringify({ value: input.value, version_check: input.version }),
    });
    return {
      id: requiredString(response.id, "id"),
      version: requiredString(response.metadata?.version_id ?? response.version_id, "version"),
    };
  },
  async revoke(input) {
    const version = encodeURIComponent(input.version);
    await workosRequest(
      env,
      `/vault/v1/kv/${encodeURIComponent(input.id)}?version_check=${version}`,
      {
        method: "DELETE",
      },
    );
  },
  async delete(input) {
    const version = encodeURIComponent(input.version);
    await workosRequest(
      env,
      `/vault/v1/kv/${encodeURIComponent(input.id)}?version_check=${version}`,
      {
        method: "DELETE",
      },
    );
  },
});

const memoryObjects = new Map<string, { value: string; version: number }>();

export const createMemoryCredentialVault = (): CredentialVault => ({
  async create(input) {
    const id = `memory-vault:${input.context.workspaceId}:${crypto.randomUUID()}`;
    memoryObjects.set(id, { value: input.value, version: 1 });
    return { id, version: "1" };
  },
  async read(input) {
    const stored = memoryObjects.get(input.id);
    if (!stored) throw new Error("vault_object_not_found");
    if (String(stored.version) !== input.version) throw new Error("vault_version_conflict");
    return { value: stored.value, version: String(stored.version) };
  },
  async replace(input) {
    const stored = memoryObjects.get(input.id);
    if (!stored) throw new Error("vault_object_not_found");
    if (String(stored.version) !== input.version) throw new Error("vault_version_conflict");
    const version = stored.version + 1;
    memoryObjects.set(input.id, { value: input.value, version });
    return { id: input.id, version: String(version) };
  },
  async revoke(input) {
    memoryObjects.delete(input.id);
  },
  async delete(input) {
    memoryObjects.delete(input.id);
  },
});

export const resolveCredentialVault = (env: Env): CredentialVault => {
  if (env.OPERLOOM_VAULT_BACKEND === "memory") {
    if (env.OPERLOOM_E2E_MODE !== "true") throw new Error("insecure_vault_backend_forbidden");
    return createMemoryCredentialVault();
  }
  if ((connectionsEnabled(env) || pushEnabled(env)) && !env.WORKOS_API_KEY?.trim())
    throw new Error("vault_not_configured");
  return createWorkOSCredentialVault(env);
};
