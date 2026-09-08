import type { AgentPackConnectionDescriptor } from "@operloom/agent-sdk/control-plane";

import type { VaultObjectReference } from "./credential-vault";
import { parseJson } from "./http";
import type { AgentIdentity, ControlConnectionRow } from "./types";

export type StoredCredential = {
  kind: "api_key" | "oauth2";
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: string;
  scopes: string[];
};

export type FlyConnectionCapabilityEnvelope = {
  url: string;
  token: string;
  connectionId: string;
  allowedUrl: string;
  allowedMethod: string;
  expiresAt: string;
};

export const sha256Hex = async (value: string) => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const randomBase64Url = (bytes = 32) => {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

export const pkceChallenge = async (verifier: string) => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

export const parseStringList = (raw: string) => {
  const value = parseJson(raw);
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
};

export const connectionSummary = (
  row: ControlConnectionRow | null,
  descriptor: AgentPackConnectionDescriptor,
) => ({
  id: descriptor.id,
  provider: descriptor.provider,
  principal: descriptor.principal,
  credentialClass: descriptor.credentialClass,
  required: descriptor.required,
  toolIds: descriptor.toolIds,
  requestedScopes: descriptor.scopes,
  status:
    row?.status ??
    (descriptor.credentialClass === "none" ? "not_required" : "authorization_required"),
  grantedScopes: row ? parseStringList(row.scopes_json) : [],
  tokenExpiresAt: row?.token_expires_at ?? undefined,
  lastUsedAt: row?.last_used_at ?? undefined,
  lastHealthAt: row?.last_health_at ?? undefined,
  lastErrorCode: row?.last_error_code ?? undefined,
  version: row?.version,
});

export const vaultContext = (identity: AgentIdentity) => ({
  workspaceId: identity.scope.workspaceId,
});

export const vaultReference = (row: ControlConnectionRow): VaultObjectReference => {
  if (!row.vault_object_id || !row.vault_version) throw new Error("connection_credentials_missing");
  return { id: row.vault_object_id, version: row.vault_version };
};
