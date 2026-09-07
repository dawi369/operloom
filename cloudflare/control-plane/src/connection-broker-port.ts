import type {
  AgentPackConnectionDescriptor,
  ConnectionCapability,
  ConnectionPort,
} from "@operloom/agent-sdk/control-plane";

import { resolveCredentialVault } from "./credential-vault";
import { connectionsEnabled } from "./feature-gates";
import { isRecord } from "./http";
import { assertProviderRequest, requireConnectionProvider } from "./connection-providers";
import { selectConnection } from "./connection-broker-persistence";
import { sha256Hex, vaultReference, type StoredCredential } from "./connection-broker-shared";
import type { AgentIdentity, Env } from "./types";

export const createBrokeredConnectionPort = (
  env: Env,
  identity: AgentIdentity,
  descriptors: readonly AgentPackConnectionDescriptor[],
): ConnectionPort => ({
  async resolve(connectionId, toolId): Promise<ConnectionCapability> {
    const descriptor = descriptors.find(
      (candidate) => candidate.id === connectionId && candidate.toolIds.includes(toolId),
    );
    if (!descriptor || descriptor.credentialClass === "none") {
      return {
        id: connectionId,
        status: "not_required",
        reason: `${toolId} does not require an external connection.`,
      };
    }
    if (!connectionsEnabled(env)) {
      return {
        id: connectionId,
        status: "authorization_required",
        reason: "Connection brokerage is disabled.",
      };
    }
    const row = await selectConnection(env, identity, connectionId);
    if (!row || row.status !== "authorized") {
      return {
        id: connectionId,
        status:
          row?.status === "revoked"
            ? "authorization_required"
            : (row?.status ?? "authorization_required"),
        reason: `${connectionId} is not authorized.`,
      };
    }
    return {
      id: connectionId,
      status: "authorized",
      reason: `${connectionId} is authorized through the platform broker.`,
      request: async (input) => {
        const provider = requireConnectionProvider(env, row.provider_id);
        const requestedUrl = input.url === "broker://configured" ? provider.actionUrl : input.url;
        if (!requestedUrl) throw new Error("connection_action_endpoint_not_configured");
        const request = assertProviderRequest(env, provider, requestedUrl, input.method);
        const credential = await readConnectionCredentialForBroker(env, identity, connectionId);
        const headers = new Headers(input.headers);
        headers.delete("authorization");
        headers.delete("x-api-key");
        if (credential.kind === "api_key") {
          if (provider.credentialPlacement === "x-api-key")
            headers.set("x-api-key", credential.apiKey ?? "");
          else headers.set("authorization", `Bearer ${credential.apiKey ?? ""}`);
        } else {
          headers.set(
            "authorization",
            `${credential.tokenType ?? "Bearer"} ${credential.accessToken ?? ""}`,
          );
        }
        const response = await fetch(request.url, {
          method: request.method,
          headers,
          body: request.method === "GET" ? undefined : input.body,
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status >= 300 && response.status < 400)
          throw new Error("provider_redirect_forbidden");
        const body = await response.text();
        if (new TextEncoder().encode(body).byteLength > 128 * 1024)
          throw new Error("provider_response_too_large");
        await env.DB.prepare(
          `UPDATE control_connections SET last_used_at = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'authorized'`,
        )
          .bind(
            new Date().toISOString(),
            new Date().toISOString(),
            row.id,
            identity.scope.userId,
            identity.scope.workspaceId,
          )
          .run();
        return {
          status: response.status,
          headers: Object.fromEntries(
            [...response.headers.entries()].filter(([name]) =>
              ["content-type", "content-length", "etag", "last-modified"].includes(
                name.toLowerCase(),
              ),
            ),
          ),
          body,
        };
      },
    };
  },
});

const readConnectionCredentialForBroker = async (
  env: Env,
  identity: AgentIdentity,
  connectionId: string,
): Promise<StoredCredential> => {
  const row = await selectConnection(env, identity, connectionId);
  if (!row || row.status !== "authorized") throw new Error("connection_not_authorized");
  const stored = await resolveCredentialVault(env).read(vaultReference(row));
  const credential = JSON.parse(stored.value) as unknown;
  if (!isRecord(credential) || (credential.kind !== "api_key" && credential.kind !== "oauth2")) {
    throw new Error("connection_credential_invalid");
  }
  return credential as StoredCredential;
};

export const connectionSecretFingerprint = sha256Hex;
