import { resolveCredentialVault } from "./credential-vault";
import { connectionsEnabled } from "./feature-gates";
import { isRecord, json } from "./http";
import { prepareOperatorAlertStatement } from "./operator-alerts";
import {
  assertProviderRequest,
  requireConnectionProvider,
  type ConnectionProvider,
} from "./connection-providers";
import {
  activePackConnections,
  requireConnectionAdmin,
  selectConnection,
} from "./connection-broker-persistence";
import {
  parseStringList,
  pkceChallenge,
  randomBase64Url,
  sha256Hex,
  vaultContext,
  vaultReference,
  type StoredCredential,
} from "./connection-broker-shared";
import { createId, toJson, type AgentIdentity, type ControlConnectionRow, type Env } from "./types";

const tokenRequest = async (
  env: Env,
  provider: ConnectionProvider,
  parameters: URLSearchParams,
): Promise<StoredCredential> => {
  if (!provider.tokenUrl || !provider.clientId) throw new Error("oauth_provider_incomplete");
  parameters.set("client_id", provider.clientId);
  if (provider.clientSecret) parameters.set("client_secret", provider.clientSecret);
  assertProviderRequest(env, provider, provider.tokenUrl, "POST");
  const response = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: parameters.toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || response.status >= 300) throw new Error("oauth_token_exchange_failed");
  const body = (await response.json().catch(() => null)) as unknown;
  if (!isRecord(body) || typeof body.access_token !== "string" || !body.access_token) {
    throw new Error("oauth_token_response_invalid");
  }
  const scopes = typeof body.scope === "string" ? body.scope.split(/[ ,]+/).filter(Boolean) : [];
  const expiresIn =
    typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
      ? Math.max(0, body.expires_in)
      : undefined;
  return {
    kind: "oauth2",
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1_000).toISOString() : undefined,
    scopes,
  };
};

export const revokeProviderCredential = async (
  env: Env,
  row: ControlConnectionRow,
  credential: StoredCredential,
) => {
  if (credential.kind !== "oauth2") return true;
  try {
    const provider = requireConnectionProvider(env, row.provider_id);
    if (!provider.revocationUrl) return false;
    const token = credential.refreshToken ?? credential.accessToken;
    if (!token) return false;
    assertProviderRequest(env, provider, provider.revocationUrl, "POST");
    const form = new URLSearchParams({ token });
    if (provider.clientId) form.set("client_id", provider.clientId);
    if (provider.clientSecret) form.set("client_secret", provider.clientSecret);
    const response = await fetch(provider.revocationUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok && response.status < 300;
  } catch {
    return false;
  }
};

export const handleStartConnectionAuthorization = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
  connectionId: string,
) => {
  if (!connectionsEnabled(env))
    return json(
      { ok: false, code: "connections_disabled", error: "Connections are disabled." },
      { status: 503 },
    );
  const adminError = await requireConnectionAdmin(env, identity);
  if (adminError) return adminError;
  const { pack, connections } = await activePackConnections(env, identity);
  const descriptor = connections.find((candidate) => candidate.id === connectionId);
  if (!pack || !descriptor || descriptor.credentialClass !== "oauth2") {
    return json({ ok: false, error: "OAuth connection not found." }, { status: 404 });
  }
  const provider = requireConnectionProvider(env, descriptor.provider);
  if (!provider.authorizationUrl || !provider.clientId || !provider.tokenUrl) {
    return json(
      {
        ok: false,
        code: "oauth_provider_incomplete",
        error: "OAuth provider is not fully configured.",
      },
      { status: 503 },
    );
  }
  const body = await request.json().catch(() => null);
  const redirectUri =
    isRecord(body) && typeof body.redirectUri === "string" ? body.redirectUri : "";
  let redirect: URL;
  try {
    redirect = new URL(redirectUri);
  } catch {
    return json({ ok: false, error: "A valid redirect URI is required." }, { status: 400 });
  }
  if (
    redirect.protocol !== "https:" &&
    !(env.OPERLOOM_E2E_MODE === "true" && redirect.hostname === "localhost")
  ) {
    return json({ ok: false, error: "OAuth redirect URI must use HTTPS." }, { status: 400 });
  }
  const state = randomBase64Url(32);
  const verifier = randomBase64Url(48);
  const challenge = await pkceChallenge(verifier);
  const timestamp = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const existing = await selectConnection(env, identity, connectionId);
  const connectionRecordId = existing?.id ?? createId("cf-connection");
  const vault = resolveCredentialVault(env);
  const verifierReference = await vault.create({
    context: vaultContext(identity),
    name: `oauth-pkce:${connectionRecordId}:${crypto.randomUUID()}`,
    value: verifier,
  });
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO control_connections (
           id, user_id, workspace_id, agent_id, pack_id, connection_id, provider_id, principal,
           credential_class, status, scopes_json, version, data_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'oauth2', 'authorization_required', ?, 1, '{}', ?, ?)
         ON CONFLICT(user_id, workspace_id, agent_id, pack_id, connection_id) DO UPDATE SET
           status = 'authorization_required', last_error_code = NULL,
           version = control_connections.version + 1, updated_at = excluded.updated_at`,
      ).bind(
        connectionRecordId,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        pack.id,
        descriptor.id,
        descriptor.provider,
        descriptor.principal,
        toJson(descriptor.scopes),
        timestamp,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO control_connection_oauth_states (
           id, user_id, workspace_id, agent_id, connection_record_id, state_hash,
           pkce_verifier_vault_object_id, pkce_verifier_vault_version, redirect_uri,
           expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        createId("cf-oauth-state"),
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        connectionRecordId,
        await sha256Hex(state),
        verifierReference.id,
        verifierReference.version,
        redirect.toString(),
        expiresAt,
        timestamp,
      ),
    ]);
  } catch (error) {
    await vault.delete(verifierReference).catch(() => undefined);
    throw error;
  }
  const authorizationUrl = new URL(provider.authorizationUrl);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", provider.clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirect.toString());
  authorizationUrl.searchParams.set("scope", descriptor.scopes.join(" "));
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  return json({ ok: true, authorizationUrl: authorizationUrl.toString(), expiresAt });
};

export const handleCompleteConnectionAuthorization = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
) => {
  if (!connectionsEnabled(env))
    return json(
      { ok: false, code: "connections_disabled", error: "Connections are disabled." },
      { status: 503 },
    );
  const body = await request.json().catch(() => null);
  const state = isRecord(body) && typeof body.state === "string" ? body.state : "";
  const code = isRecord(body) && typeof body.code === "string" ? body.code : "";
  if (!state || !code)
    return json({ ok: false, error: "OAuth state and code are required." }, { status: 400 });
  const stateHash = await sha256Hex(state);
  const oauthState = await env.DB.prepare(
    `SELECT id, connection_record_id, pkce_verifier_vault_object_id,
            pkce_verifier_vault_version, redirect_uri, expires_at
     FROM control_connection_oauth_states
     WHERE state_hash = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?
       AND used_at IS NULL AND expires_at > ? LIMIT 1`,
  )
    .bind(
      stateHash,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      new Date().toISOString(),
    )
    .first<{
      id: string;
      connection_record_id: string;
      pkce_verifier_vault_object_id: string;
      pkce_verifier_vault_version: string;
      redirect_uri: string;
      expires_at: string;
    }>();
  if (!oauthState)
    return json(
      {
        ok: false,
        code: "oauth_state_invalid",
        error: "OAuth state is invalid, expired, or already used.",
      },
      { status: 409 },
    );
  const claimedAt = new Date().toISOString();
  const claimed = (await env.DB.prepare(
    `UPDATE control_connection_oauth_states SET used_at = ?
     WHERE id = ? AND used_at IS NULL AND expires_at > ?`,
  )
    .bind(claimedAt, oauthState.id, claimedAt)
    .run()) as { meta?: { changes?: number } };
  if ((claimed.meta?.changes ?? 0) === 0)
    return json(
      { ok: false, code: "oauth_state_replayed", error: "OAuth state was already consumed." },
      { status: 409 },
    );
  const connection = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, pack_id, connection_id, provider_id,
            principal, credential_class, status, scopes_json, vault_object_id, vault_version,
            token_expires_at, refresh_lease_owner, refresh_lease_expires_at, last_used_at,
            last_health_at, last_error_code, version, data_json, created_at, updated_at, revoked_at
     FROM control_connections WHERE id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`,
  )
    .bind(oauthState.connection_record_id, identity.scope.userId, identity.scope.workspaceId)
    .first<ControlConnectionRow>();
  if (!connection) return json({ ok: false, error: "Connection not found." }, { status: 404 });
  const provider = requireConnectionProvider(env, connection.provider_id);
  const vault = resolveCredentialVault(env);
  const verifierReference = {
    id: oauthState.pkce_verifier_vault_object_id,
    version: oauthState.pkce_verifier_vault_version,
  };
  try {
    const verifier = await vault.read(verifierReference);
    const credential = await tokenRequest(
      env,
      provider,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: oauthState.redirect_uri,
        code_verifier: verifier.value,
      }),
    );
    const requestedScopes = parseStringList(connection.scopes_json);
    const grantedScopes = credential.scopes.length ? credential.scopes : requestedScopes;
    if (requestedScopes.some((scope) => !grantedScopes.includes(scope)))
      throw new Error("oauth_scope_missing");
    credential.scopes = grantedScopes;
    const credentialReference =
      connection.vault_object_id && connection.vault_version
        ? await vault.replace({ ...vaultReference(connection), value: JSON.stringify(credential) })
        : await vault.create({
            context: vaultContext(identity),
            name: `connection:${connection.id}`,
            value: JSON.stringify(credential),
          });
    const timestamp = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE control_connections SET status = 'authorized', scopes_json = ?, vault_object_id = ?,
           vault_version = ?, token_expires_at = ?, last_error_code = NULL, revoked_at = NULL,
           version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND workspace_id = ?`,
      ).bind(
        toJson(grantedScopes),
        credentialReference.id,
        credentialReference.version,
        credential.expiresAt ?? null,
        timestamp,
        connection.id,
        identity.scope.userId,
        identity.scope.workspaceId,
      ),
      env.DB.prepare(
        `INSERT INTO control_audit_events (
           id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
         ) VALUES (?, ?, ?, 'connection.authorized', 'OAuth connection authorized.',
           'connection', ?, ?, ?)`,
      ).bind(
        createId("cf-audit"),
        identity.scope.userId,
        identity.scope.workspaceId,
        connection.id,
        toJson({ provider: connection.provider_id, scopes: grantedScopes }),
        timestamp,
      ),
    ]);
    await vault.delete(verifierReference).catch(() => undefined);
    await env.DB.prepare(
      `DELETE FROM control_connection_oauth_states WHERE id = ? AND used_at IS NOT NULL`,
    )
      .bind(oauthState.id)
      .run();
    return json({ ok: true, connectionId: connection.connection_id, status: "authorized" });
  } catch (error) {
    await vault.delete(verifierReference).catch(() => undefined);
    await env.DB.prepare(
      `DELETE FROM control_connection_oauth_states WHERE id = ? AND used_at IS NOT NULL`,
    )
      .bind(oauthState.id)
      .run();
    await env.DB.prepare(
      `UPDATE control_connections SET status = 'unhealthy', last_error_code = ?,
         version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND workspace_id = ?`,
    )
      .bind(
        error instanceof Error ? error.message.slice(0, 80) : "oauth_failed",
        new Date().toISOString(),
        connection.id,
        identity.scope.userId,
        identity.scope.workspaceId,
      )
      .run();
    return json(
      { ok: false, code: "oauth_exchange_failed", error: "OAuth authorization failed." },
      { status: 502 },
    );
  }
};

export const expireConnectionOAuthStates = async (env: Env, now = new Date()) => {
  if (!connectionsEnabled(env)) return { expired: 0, failed: 0 };
  const timestamp = now.toISOString();
  await env.DB.prepare(
    `DELETE FROM control_connection_capabilities
     WHERE expires_at <= ? OR consumed_at IS NOT NULL`,
  )
    .bind(timestamp)
    .run();
  const rows = await env.DB.prepare(
    `SELECT id, pkce_verifier_vault_object_id, pkce_verifier_vault_version
     FROM control_connection_oauth_states WHERE expires_at <= ? LIMIT 25`,
  )
    .bind(timestamp)
    .all<{
      id: string;
      pkce_verifier_vault_object_id: string;
      pkce_verifier_vault_version: string;
    }>();
  const vault = resolveCredentialVault(env);
  let expired = 0;
  let failed = 0;
  for (const row of rows.results) {
    try {
      await vault.delete({
        id: row.pkce_verifier_vault_object_id,
        version: row.pkce_verifier_vault_version,
      });
      await env.DB.prepare(
        "DELETE FROM control_connection_oauth_states WHERE id = ? AND expires_at <= ?",
      )
        .bind(row.id, timestamp)
        .run();
      expired += 1;
    } catch {
      failed += 1;
    }
  }
  return { expired, failed };
};

export const handleRefreshConnection = async (
  env: Env,
  identity: AgentIdentity,
  connectionId: string,
) => {
  const adminError = await requireConnectionAdmin(env, identity);
  if (adminError) return adminError;
  const row = await selectConnection(env, identity, connectionId);
  if (!row) return json({ ok: false, error: "Connection not found." }, { status: 404 });
  if (row.credential_class !== "oauth2" || !row.vault_object_id || !row.vault_version) {
    return json(
      { ok: false, code: "refresh_not_supported", error: "Connection cannot be refreshed." },
      { status: 409 },
    );
  }
  const leaseOwner = createId("cf-refresh");
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + 30_000).toISOString();
  const claimed = (await env.DB.prepare(
    `UPDATE control_connections SET refresh_lease_owner = ?, refresh_lease_expires_at = ?,
       version = version + 1, updated_at = ?
     WHERE id = ? AND user_id = ? AND workspace_id = ?
       AND (refresh_lease_expires_at IS NULL OR refresh_lease_expires_at <= ?)`,
  )
    .bind(
      leaseOwner,
      leaseExpiresAt,
      now.toISOString(),
      row.id,
      identity.scope.userId,
      identity.scope.workspaceId,
      now.toISOString(),
    )
    .run()) as { meta?: { changes?: number } };
  if ((claimed.meta?.changes ?? 0) === 0) {
    return json(
      {
        ok: false,
        code: "refresh_in_progress",
        error: "Connection refresh is already in progress.",
      },
      { status: 409 },
    );
  }
  try {
    const provider = requireConnectionProvider(env, row.provider_id);
    const vault = resolveCredentialVault(env);
    const stored = await vault.read(vaultReference(row));
    const credential = JSON.parse(stored.value) as StoredCredential;
    if (!credential.refreshToken) throw new Error("oauth_refresh_token_missing");
    const refreshed = await tokenRequest(
      env,
      provider,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
      }),
    );
    if (!refreshed.refreshToken) refreshed.refreshToken = credential.refreshToken;
    if (!refreshed.scopes.length) refreshed.scopes = credential.scopes;
    const reference = await vault.replace({
      ...vaultReference(row),
      value: JSON.stringify(refreshed),
    });
    const timestamp = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE control_connections SET status = 'authorized', scopes_json = ?, vault_version = ?,
         token_expires_at = ?, refresh_lease_owner = NULL, refresh_lease_expires_at = NULL,
         last_error_code = NULL, version = version + 1, updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND refresh_lease_owner = ?`,
    )
      .bind(
        toJson(refreshed.scopes),
        reference.version,
        refreshed.expiresAt ?? null,
        timestamp,
        row.id,
        identity.scope.userId,
        identity.scope.workspaceId,
        leaseOwner,
      )
      .run();
    return json({
      ok: true,
      connectionId,
      status: "authorized",
      tokenExpiresAt: refreshed.expiresAt,
    });
  } catch {
    const timestamp = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE control_connections SET status = 'refresh_required', refresh_lease_owner = NULL,
           refresh_lease_expires_at = NULL, last_error_code = 'connection_refresh_failed',
           version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND workspace_id = ? AND refresh_lease_owner = ?`,
      ).bind(timestamp, row.id, identity.scope.userId, identity.scope.workspaceId, leaseOwner),
      prepareOperatorAlertStatement(env, {
        userId: identity.scope.userId,
        workspaceId: identity.scope.workspaceId,
        agentId: identity.agentId,
        severity: "warning",
        code: "connection_refresh_failed",
        summary: "An OAuth connection refresh failed and requires attention.",
        targetType: "connection",
        targetId: row.id,
        dedupKey: `connection-refresh:${row.id}:${row.version}`,
        data: { connectionId: row.connection_id, provider: row.provider_id },
        timestamp,
      }),
    ]);
    return json(
      { ok: false, code: "connection_refresh_failed", error: "Connection refresh failed." },
      { status: 502 },
    );
  }
};
