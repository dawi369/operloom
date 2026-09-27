import { resolveCredentialVault } from "./credential-vault";
import { connectionsEnabled } from "./feature-gates";
import { isRecord, json } from "./http";
import { assertProviderRequest, requireConnectionProvider } from "./connection-providers";
import {
  randomBase64Url,
  sha256Hex,
  type FlyConnectionCapabilityEnvelope,
  type StoredCredential,
} from "./connection-broker-shared";
import { createId, type AgentIdentity, type Env } from "./types";

export const issueFlyConnectionCapability = async (
  env: Env,
  identity: AgentIdentity,
  input: {
    connectionRecordId: string;
    connectionId: string;
    runId: string;
    workflowIntentId: string;
    toolCallId: string;
    toolId: string;
    timeoutMs: number;
  },
): Promise<FlyConnectionCapabilityEnvelope> => {
  const callbackUrl = env.OPERLOOM_CALLBACK_URL?.trim();
  if (!callbackUrl) throw new Error("connection_broker_url_not_configured");
  const row = await env.DB.prepare(
    `SELECT provider_id, status FROM control_connections
     WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?
       AND connection_id = ? LIMIT 1`,
  )
    .bind(
      input.connectionRecordId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      input.connectionId,
    )
    .first<{ provider_id: string; status: string }>();
  if (!row || row.status !== "authorized") throw new Error("connection_not_authorized");
  const provider = requireConnectionProvider(env, row.provider_id);
  if (!provider.actionUrl) throw new Error("connection_action_endpoint_not_configured");
  const request = assertProviderRequest(env, provider, provider.actionUrl, "POST");
  const token = randomBase64Url(32);
  const tokenSha256 = await sha256Hex(token);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(
    Date.now() + Math.max(5_000, Math.min(60_000, input.timeoutMs + 5_000)),
  ).toISOString();
  const inserted = (await env.DB.prepare(
    `INSERT INTO control_connection_capabilities (
       id, token_sha256, user_id, workspace_id, agent_id, connection_record_id,
       run_id, workflow_intent_id, tool_call_id, tool_id, allowed_url, allowed_method,
       expires_at, created_at
     ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM control_runs
         WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?
           AND status = 'running'
       )`,
  )
    .bind(
      createId("cf-connection-capability"),
      tokenSha256,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      input.connectionRecordId,
      input.runId,
      input.workflowIntentId,
      input.toolCallId,
      input.toolId,
      request.url.toString(),
      request.method,
      expiresAt,
      createdAt,
      input.runId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
    )
    .run()) as { meta?: { changes?: number } };
  if ((inserted.meta?.changes ?? 0) !== 1) {
    throw new Error("connection_capability_publication_revoked");
  }
  const origin = new URL(callbackUrl).origin;
  return {
    url: `${origin}/workbench/connection-capabilities/redeem`,
    token,
    connectionId: input.connectionId,
    allowedUrl: request.url.toString(),
    allowedMethod: request.method,
    expiresAt,
  };
};

export const handleRedeemConnectionCapability = async (request: Request, env: Env) => {
  if (!connectionsEnabled(env)) {
    return json(
      { ok: false, code: "connections_disabled", error: "Connection brokerage is disabled." },
      { status: 503 },
    );
  }
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token || token.length > 256) {
    return json(
      { ok: false, code: "capability_required", error: "A broker capability is required." },
      { status: 401 },
    );
  }
  const body = await request.json().catch(() => null);
  if (!isRecord(body) || typeof body.url !== "string") {
    return json(
      { ok: false, code: "capability_request_invalid", error: "The broker request is invalid." },
      { status: 400 },
    );
  }
  const method = typeof body.method === "string" ? body.method.toUpperCase() : "GET";
  const tokenSha256 = await sha256Hex(token);
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT c.id AS capability_id, c.user_id, c.workspace_id, c.agent_id,
            c.connection_record_id, c.run_id, c.workflow_intent_id, c.tool_call_id,
            c.tool_id, c.allowed_url, c.allowed_method,
            x.id, x.provider_id, x.status, x.vault_object_id, x.vault_version
     FROM control_connection_capabilities c
     JOIN control_connections x ON x.id = c.connection_record_id
     JOIN control_runs r ON r.id = c.run_id
     WHERE c.token_sha256 = ? AND c.consumed_at IS NULL AND c.expires_at > ?
       AND x.status = 'authorized' AND r.status = 'running'
       AND r.user_id = c.user_id AND r.workspace_id = c.workspace_id
     LIMIT 1`,
  )
    .bind(tokenSha256, now)
    .first<{
      capability_id: string;
      user_id: string;
      workspace_id: string;
      agent_id: string;
      connection_record_id: string;
      run_id: string;
      workflow_intent_id: string;
      tool_call_id: string;
      tool_id: string;
      allowed_url: string;
      allowed_method: string;
      provider_id: string;
      status: string;
      vault_object_id: string | null;
      vault_version: string | null;
    }>();
  if (!row || body.url !== row.allowed_url || method !== row.allowed_method) {
    return json(
      {
        ok: false,
        code: "capability_invalid",
        error: "The broker capability is invalid, expired, or out of scope.",
      },
      { status: 403 },
    );
  }
  const claimed = (await env.DB.prepare(
    `UPDATE control_connection_capabilities SET consumed_at = ?
     WHERE id = ? AND token_sha256 = ? AND consumed_at IS NULL AND expires_at > ?`,
  )
    .bind(now, row.capability_id, tokenSha256, now)
    .run()) as { meta?: { changes?: number } };
  if ((claimed.meta?.changes ?? 0) !== 1) {
    return json(
      {
        ok: false,
        code: "capability_replayed",
        error: "The broker capability was already consumed.",
      },
      { status: 409 },
    );
  }
  try {
    if (!row.vault_object_id || !row.vault_version)
      throw new Error("connection_credentials_missing");
    const provider = requireConnectionProvider(env, row.provider_id);
    const providerRequest = assertProviderRequest(env, provider, row.allowed_url, method);
    const stored = await resolveCredentialVault(env).read({
      id: row.vault_object_id,
      version: row.vault_version,
    });
    const credential = JSON.parse(stored.value) as StoredCredential;
    const headers = new Headers(
      isRecord(body.headers) ? (body.headers as Record<string, string>) : undefined,
    );
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
    const response = await fetch(providerRequest.url, {
      method: providerRequest.method,
      headers,
      body:
        providerRequest.method === "GET"
          ? undefined
          : typeof body.body === "string"
            ? body.body
            : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status >= 300 && response.status < 400)
      throw new Error("provider_redirect_forbidden");
    const responseBody = await response.text();
    if (new TextEncoder().encode(responseBody).byteLength > 128 * 1024)
      throw new Error("provider_response_too_large");
    await env.DB.prepare(
      `UPDATE control_connections SET last_used_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND status = 'authorized'`,
    )
      .bind(now, now, row.connection_record_id)
      .run();
    return json({
      ok: true,
      response: {
        status: response.status,
        headers: Object.fromEntries(
          [...response.headers.entries()].filter(([name]) =>
            ["content-type", "content-length", "etag", "last-modified"].includes(
              name.toLowerCase(),
            ),
          ),
        ),
        body: responseBody,
      },
    });
  } catch {
    return json(
      { ok: false, code: "broker_request_failed", error: "The brokered provider request failed." },
      { status: 502 },
    );
  }
};
