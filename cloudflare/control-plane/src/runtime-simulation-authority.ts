import type { AgentIdentity, ToolPermissionRow } from "./types";
export type SimulationAuthority = {
  toolId: string;
  membershipRole: string;
  permission?: ToolPermissionRow;
};
export const simulationCommitGuard = (identity: AgentIdentity, authority?: SimulationAuthority) => {
  if (!authority) return { sql: "1=1", values: [] as unknown[] };
  const scope = [
    identity.scope.userId,
    identity.scope.workspaceId,
    identity.agentId,
    authority.toolId,
  ];
  const permission = authority.permission;
  return {
    sql: `EXISTS (SELECT 1 FROM memberships WHERE user_id=? AND workspace_id=? AND status='active' AND role=?)
      AND NOT EXISTS (SELECT 1 FROM control_kill_switches WHERE user_id=? AND workspace_id=? AND scope_kind='tool' AND scope_id=? AND enabled=1)
      AND ${
        permission
          ? `EXISTS (SELECT 1 FROM tool_permissions WHERE user_id=? AND workspace_id=? AND agent_id=? AND tool_id=? AND id=? AND status=? AND execution_json=? AND data_json=?)`
          : `NOT EXISTS (SELECT 1 FROM tool_permissions WHERE user_id=? AND workspace_id=? AND agent_id=? AND tool_id=?)`
      }`,
    values: [
      identity.scope.userId,
      identity.scope.workspaceId,
      authority.membershipRole,
      identity.scope.userId,
      identity.scope.workspaceId,
      authority.toolId,
      ...scope,
      ...(permission
        ? [permission.id, permission.status, permission.execution_json, permission.data_json]
        : []),
    ],
  };
};
