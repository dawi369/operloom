import { resolveCredentialVault } from "./credential-vault";
import { connectionsEnabled } from "./feature-gates";
import { isRecord, json } from "./http";
import { revokeProviderCredential } from "./connection-broker-oauth";
import {
  activePackConnections,
  requireConnectionAdmin,
  selectConnection,
} from "./connection-broker-persistence";
import {
  connectionSummary,
  vaultContext,
  vaultReference,
  type StoredCredential,
} from "./connection-broker-shared";
import { createId, toJson, type AgentIdentity, type ControlConnectionRow, type Env } from "./types";

export const handleListConnections = async (env: Env, identity: AgentIdentity) => {
  const { pack, connections } = await activePackConnections(env, identity);
  if (!pack) return json({ ok: true, packId: null, connections: [] });
  const rows = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, pack_id, connection_id, provider_id,
            principal, credential_class, status, scopes_json, vault_object_id, vault_version,
            token_expires_at, refresh_lease_owner, refresh_lease_expires_at, last_used_at,
            last_health_at, last_error_code, version, data_json, created_at, updated_at, revoked_at
     FROM control_connections
     WHERE user_id = ? AND workspace_id = ? AND agent_id = ? AND pack_id = ?`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, identity.agentId, pack.id)
    .all<ControlConnectionRow>();
  const byDescriptor = new Map(rows.results.map((row) => [row.connection_id, row]));
  return json({
    ok: true,
    enabled: connectionsEnabled(env),
    packId: pack.id,
    connections: connections.map((descriptor) =>
      connectionSummary(byDescriptor.get(descriptor.id) ?? null, descriptor),
    ),
  });
};

export const handleStoreConnectionCredential = async (
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
  if (!pack || !descriptor || descriptor.credentialClass === "none") {
    return json({ ok: false, error: "Connection not found." }, { status: 404 });
  }
  const body = await request.json().catch(() => null);
  if (!isRecord(body))
    return json({ ok: false, error: "Invalid credential payload." }, { status: 400 });
  const secret = typeof body.secret === "string" ? body.secret.trim() : "";
  if (!secret || secret.length > 16_384)
    return json(
      { ok: false, error: "Credential must be bounded non-empty text." },
      { status: 400 },
    );
  if (descriptor.credentialClass === "oauth2" && env.OPERLOOM_E2E_MODE !== "true") {
    return json(
      {
        ok: false,
        code: "oauth_flow_required",
        error: "OAuth connections must use the authorization flow.",
      },
      { status: 400 },
    );
  }

  const timestamp = new Date().toISOString();
  const existing = await selectConnection(env, identity, connectionId);
  const recordId = existing?.id ?? createId("cf-connection");
  const credential: StoredCredential =
    descriptor.credentialClass === "api_key"
      ? { kind: "api_key", apiKey: secret, scopes: [...descriptor.scopes] }
      : {
          kind: "oauth2",
          accessToken: secret,
          tokenType: "Bearer",
          scopes: [...descriptor.scopes],
        };
  const vault = resolveCredentialVault(env);
  const stored =
    existing?.vault_object_id && existing.vault_version
      ? await vault.replace({ ...vaultReference(existing), value: JSON.stringify(credential) })
      : await vault.create({
          context: vaultContext(identity),
          name: `connection:${recordId}`,
          value: JSON.stringify(credential),
        });
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO control_connections (
         id, user_id, workspace_id, agent_id, pack_id, connection_id, provider_id, principal,
         credential_class, status, scopes_json, vault_object_id, vault_version, version,
         data_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'authorized', ?, ?, ?, 1, '{}', ?, ?)
       ON CONFLICT(user_id, workspace_id, agent_id, pack_id, connection_id) DO UPDATE SET
         status = 'authorized', scopes_json = excluded.scopes_json,
         vault_object_id = excluded.vault_object_id, vault_version = excluded.vault_version,
         last_error_code = NULL, revoked_at = NULL, version = control_connections.version + 1,
         updated_at = excluded.updated_at`,
      ).bind(
        recordId,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        pack.id,
        connectionId,
        descriptor.provider,
        descriptor.principal,
        descriptor.credentialClass,
        toJson(descriptor.scopes),
        stored.id,
        stored.version,
        timestamp,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO control_audit_events (
         id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
       ) VALUES (?, ?, ?, 'connection.authorized', 'External connection authorized.',
         'connection', ?, ?, ?)`,
      ).bind(
        createId("cf-audit"),
        identity.scope.userId,
        identity.scope.workspaceId,
        recordId,
        toJson({
          packId: pack.id,
          connectionId,
          provider: descriptor.provider,
          scopes: descriptor.scopes,
        }),
        timestamp,
      ),
    ]);
  } catch (error) {
    if (!existing?.vault_object_id) await vault.delete(stored).catch(() => undefined);
    throw error;
  }
  return json(
    { ok: true, connection: { ...connectionSummary(null, descriptor), status: "authorized" } },
    { status: existing ? 200 : 201 },
  );
};

export const handleRevokeConnection = async (
  env: Env,
  identity: AgentIdentity,
  connectionId: string,
) => {
  const adminError = await requireConnectionAdmin(env, identity);
  if (adminError) return adminError;
  const row = await selectConnection(env, identity, connectionId);
  if (!row) return json({ ok: false, error: "Connection not found." }, { status: 404 });
  let providerRevoked = row.credential_class !== "oauth2";
  if (row.vault_object_id && row.vault_version) {
    const vault = resolveCredentialVault(env);
    const stored = await vault.read(vaultReference(row));
    const credential = JSON.parse(stored.value) as StoredCredential;
    providerRevoked = await revokeProviderCredential(env, row, credential);
    await vault.revoke(vaultReference(row));
  }
  const timestamp = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE control_connections SET status = 'revoked', vault_object_id = NULL,
         vault_version = NULL, token_expires_at = NULL, last_error_code = ?,
         revoked_at = ?, version = version + 1,
         updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND status <> 'revoked'`,
    ).bind(
      providerRevoked ? null : "provider_revocation_unconfirmed",
      timestamp,
      timestamp,
      row.id,
      identity.scope.userId,
      identity.scope.workspaceId,
    ),
    env.DB.prepare(
      `INSERT INTO control_audit_events (
         id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
       ) VALUES (?, ?, ?, 'connection.revoked', 'External connection revoked.', 'connection', ?, '{}', ?)`,
    ).bind(
      createId("cf-audit"),
      identity.scope.userId,
      identity.scope.workspaceId,
      row.id,
      timestamp,
    ),
  ]);
  return json({ ok: true, connectionId, status: "revoked", providerRevoked });
};

export const handleConnectionHealth = async (
  env: Env,
  identity: AgentIdentity,
  connectionId: string,
) => {
  const row = await selectConnection(env, identity, connectionId);
  if (!row) return json({ ok: false, error: "Connection not found." }, { status: 404 });
  const timestamp = new Date().toISOString();
  const expired = Boolean(row.token_expires_at && row.token_expires_at <= timestamp);
  const status = row.status === "authorized" && expired ? "refresh_required" : row.status;
  await env.DB.prepare(
    `UPDATE control_connections SET status = ?, last_health_at = ?,
       last_error_code = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND user_id = ? AND workspace_id = ?`,
  )
    .bind(
      status,
      timestamp,
      expired ? "token_expired" : null,
      timestamp,
      row.id,
      identity.scope.userId,
      identity.scope.workspaceId,
    )
    .run();
  return json({ ok: status === "authorized", connectionId, status, checkedAt: timestamp });
};

export const revokeWorkspaceConnections = async (env: Env, identity: AgentIdentity) => {
  const rows = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, pack_id, connection_id, provider_id,
            principal, credential_class, status, scopes_json, vault_object_id, vault_version,
            token_expires_at, refresh_lease_owner, refresh_lease_expires_at, last_used_at,
            last_health_at, last_error_code, version, data_json, created_at, updated_at, revoked_at
     FROM control_connections WHERE workspace_id = ? AND status <> 'revoked'`,
  )
    .bind(identity.scope.workspaceId)
    .all<ControlConnectionRow>();
  const oauthStates = await env.DB.prepare(
    `SELECT id, pkce_verifier_vault_object_id, pkce_verifier_vault_version
     FROM control_connection_oauth_states WHERE workspace_id = ?`,
  )
    .bind(identity.scope.workspaceId)
    .all<{
      id: string;
      pkce_verifier_vault_object_id: string;
      pkce_verifier_vault_version: string;
    }>();
  const vault = resolveCredentialVault(env);
  let revoked = 0;
  let failed = 0;
  for (const row of rows.results) {
    if (row.vault_object_id && row.vault_version) {
      try {
        const stored = await vault.read(vaultReference(row));
        const providerRevoked = await revokeProviderCredential(
          env,
          row,
          JSON.parse(stored.value) as StoredCredential,
        ).catch(() => false);
        await vault.revoke(vaultReference(row));
        const timestamp = new Date().toISOString();
        await env.DB.prepare(
          `UPDATE control_connections SET status = 'revoked', vault_object_id = NULL,
             vault_version = NULL, token_expires_at = NULL, last_error_code = ?, revoked_at = ?,
             version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ?`,
        )
          .bind(
            providerRevoked ? null : "provider_revocation_unconfirmed",
            timestamp,
            timestamp,
            row.id,
            identity.scope.workspaceId,
          )
          .run();
        revoked += 1;
      } catch {
        failed += 1;
      }
    } else {
      const timestamp = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE control_connections SET status = 'revoked', token_expires_at = NULL,
           revoked_at = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
      )
        .bind(timestamp, timestamp, row.id, identity.scope.workspaceId)
        .run();
      revoked += 1;
    }
  }
  for (const state of oauthStates.results) {
    try {
      await vault.delete({
        id: state.pkce_verifier_vault_object_id,
        version: state.pkce_verifier_vault_version,
      });
      await env.DB.prepare(
        "DELETE FROM control_connection_oauth_states WHERE id = ? AND workspace_id = ?",
      )
        .bind(state.id, identity.scope.workspaceId)
        .run();
    } catch {
      failed += 1;
    }
  }
  await env.DB.prepare("DELETE FROM control_connection_capabilities WHERE workspace_id = ?")
    .bind(identity.scope.workspaceId)
    .run();
  return { inspected: rows.results.length + oauthStates.results.length, revoked, failed };
};
