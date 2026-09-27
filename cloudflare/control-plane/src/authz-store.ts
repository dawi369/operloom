import type {
  ActiveWorkspacePreferenceRow,
  ActiveAgentPreferenceRow,
  AgentRow,
  Env,
  MembershipRow,
  UserRow,
  WorkspaceRow,
} from "./types";

export const selectUser = (env: Env, userId: string) =>
  env.DB.prepare(
    `SELECT id, email, display_name, status, data_json, created_at, updated_at
     FROM users
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(userId)
    .first<UserRow>();

export const selectWorkspace = (env: Env, workspaceId: string) =>
  env.DB.prepare(
    `SELECT id, account_id, account_source, name, status, is_default,
            created_by_user_id, data_json, deletion_requested_by_user_id,
            deletion_requested_at, purge_after, purged_at, created_at, updated_at
     FROM workspaces
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(workspaceId)
    .first<WorkspaceRow>();

export const selectDefaultWorkspaceForAccount = (env: Env, accountId: string) =>
  env.DB.prepare(
    `SELECT id, account_id, account_source, name, status, is_default,
            created_by_user_id, data_json, deletion_requested_by_user_id,
            deletion_requested_at, purge_after, purged_at, created_at, updated_at
     FROM workspaces
     WHERE account_id = ? AND is_default = 1
     LIMIT 1`,
  )
    .bind(accountId)
    .first<WorkspaceRow>();

export const selectActiveWorkspacePreference = (
  env: Env,
  input: { userId: string; accountId: string },
) =>
  env.DB.prepare(
    `SELECT user_id, account_id, workspace_id, data_json, created_at, updated_at
     FROM active_workspace_preferences
     WHERE user_id = ? AND account_id = ?
     LIMIT 1`,
  )
    .bind(input.userId, input.accountId)
    .first<ActiveWorkspacePreferenceRow>();

export const selectActiveAgentPreference = (
  env: Env,
  input: { userId: string; workspaceId: string },
) =>
  env.DB.prepare(
    `SELECT user_id, workspace_id, agent_id, data_json, created_at, updated_at
     FROM active_agent_preferences
     WHERE user_id = ? AND workspace_id = ?
     LIMIT 1`,
  )
    .bind(input.userId, input.workspaceId)
    .first<ActiveAgentPreferenceRow>();

export const selectAccountWorkspacesForUser = (
  env: Env,
  input: { userId: string; accountId: string },
) =>
  env.DB.prepare(
    `SELECT workspaces.id, workspaces.account_id, workspaces.account_source,
            workspaces.name, workspaces.status, workspaces.is_default,
            workspaces.created_by_user_id, workspaces.data_json,
            workspaces.deletion_requested_by_user_id, workspaces.deletion_requested_at,
            workspaces.purge_after, workspaces.purged_at, workspaces.created_at,
            workspaces.updated_at
     FROM workspaces
     INNER JOIN memberships ON memberships.workspace_id = workspaces.id
     WHERE workspaces.account_id = ? AND memberships.user_id = ? AND memberships.status = 'active'
     ORDER BY workspaces.is_default DESC, workspaces.updated_at DESC, workspaces.created_at DESC`,
  )
    .bind(input.accountId, input.userId)
    .all<WorkspaceRow>();

export const selectMembership = (env: Env, userId: string, workspaceId: string) =>
  env.DB.prepare(
    `SELECT id, user_id, workspace_id, role, status, roles_json, permissions_json,
            data_json, created_at, updated_at
     FROM memberships
     WHERE user_id = ? AND workspace_id = ?
     LIMIT 1`,
  )
    .bind(userId, workspaceId)
    .first<MembershipRow>();

export const countWorkspaceMemberships = (env: Env, workspaceId: string) =>
  env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM memberships
     WHERE workspace_id = ?`,
  )
    .bind(workspaceId)
    .first<{ count: number }>();

export const countActiveWorkspaceOwners = (env: Env, workspaceId: string) =>
  env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM memberships
     WHERE workspace_id = ? AND status = 'active' AND lower(role) = 'owner'`,
  )
    .bind(workspaceId)
    .first<{ count: number }>();

export const selectWorkspaceMemberships = (env: Env, workspaceId: string) =>
  env.DB.prepare(
    `SELECT memberships.id, memberships.user_id, memberships.workspace_id,
            memberships.role, memberships.status, memberships.roles_json,
            memberships.permissions_json, memberships.data_json,
            memberships.created_at, memberships.updated_at,
            users.email, users.display_name, users.status AS user_status
     FROM memberships
     LEFT JOIN users ON users.id = memberships.user_id
     WHERE memberships.workspace_id = ?
     ORDER BY
       CASE lower(memberships.role)
         WHEN 'owner' THEN 0
         WHEN 'admin' THEN 1
         ELSE 2
       END,
       COALESCE(users.display_name, users.email, memberships.user_id) ASC`,
  )
    .bind(workspaceId)
    .all<
      MembershipRow & {
        email: string | null;
        display_name: string | null;
        user_status: string | null;
      }
    >();

export const selectDefaultAgent = (env: Env, workspaceId: string) =>
  env.DB.prepare(
    `SELECT id, workspace_id, name, description, status, is_default, created_by_user_id,
            data_json, created_at, updated_at, runtime_revision
     FROM agents
     WHERE workspace_id = ? AND is_default = 1
     LIMIT 1`,
  )
    .bind(workspaceId)
    .first<AgentRow>();

export const selectAgent = (env: Env, agentId: string, workspaceId: string) =>
  env.DB.prepare(
    `SELECT id, workspace_id, name, description, status, is_default, created_by_user_id,
            data_json, created_at, updated_at, runtime_revision
     FROM agents
     WHERE id = ? AND workspace_id = ?
     LIMIT 1`,
  )
    .bind(agentId, workspaceId)
    .first<AgentRow>();

export const selectWorkspaceAgents = (env: Env, workspaceId: string) =>
  env.DB.prepare(
    `SELECT id, workspace_id, name, description, status, is_default, created_by_user_id,
            data_json, created_at, updated_at, runtime_revision
     FROM agents
     WHERE workspace_id = ?
     ORDER BY is_default DESC, updated_at DESC, created_at DESC`,
  )
    .bind(workspaceId)
    .all<AgentRow>();
