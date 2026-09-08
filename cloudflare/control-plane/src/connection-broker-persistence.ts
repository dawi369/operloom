import type { AgentPackConnectionDescriptor } from "@operloom/agent-sdk/control-plane";

import { resolveAgentBehaviorConfig } from "./agent-records";
import { selectAgent, selectMembership } from "./authz-store";
import { requireAdminMembership } from "./membership-policy";
import type { AgentIdentity, ControlConnectionRow, Env } from "./types";

export const activePackConnections = async (env: Env, identity: AgentIdentity) => {
  const agent = await selectAgent(env, identity.agentId, identity.scope.workspaceId);
  if (!agent)
    return { agent: null, pack: null, connections: [] as readonly AgentPackConnectionDescriptor[] };
  const pack = resolveAgentBehaviorConfig(agent).pack;
  return { agent, pack, connections: pack?.connections ?? [] };
};

export const selectConnection = (env: Env, identity: AgentIdentity, connectionId: string) =>
  env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, pack_id, connection_id, provider_id,
            principal, credential_class, status, scopes_json, vault_object_id, vault_version,
            token_expires_at, refresh_lease_owner, refresh_lease_expires_at, last_used_at,
            last_health_at, last_error_code, version, data_json, created_at, updated_at, revoked_at
     FROM control_connections
     WHERE user_id = ? AND workspace_id = ? AND agent_id = ? AND connection_id = ? LIMIT 1`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, identity.agentId, connectionId)
    .first<ControlConnectionRow>();

export const requireConnectionAdmin = async (env: Env, identity: AgentIdentity) => {
  const membership = await selectMembership(env, identity.scope.userId, identity.scope.workspaceId);
  return requireAdminMembership(membership);
};
