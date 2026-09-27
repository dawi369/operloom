import { json, parseJson } from "./http";
import { selectAgent, selectMembership, selectUser, selectWorkspace } from "./authz-store";
import type { AgentIdentity, Env } from "./types";

const authModeHeader = "x-operloom-auth-mode";
const workspaceSourceHeader = "x-operloom-workspace-source";

const readOptionalHeader = (request: Request, name: string) =>
  request.headers.get(name)?.trim() || undefined;

const parseStringArray = (raw: string) => {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
};

export const handleWorkspaceContext = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
) => {
  const [user, workspace, membership, agent] = await Promise.all([
    selectUser(env, identity.scope.userId),
    selectWorkspace(env, identity.scope.workspaceId),
    selectMembership(env, identity.scope.userId, identity.scope.workspaceId),
    selectAgent(env, identity.agentId, identity.scope.workspaceId),
  ]);

  return json({
    ok: true,
    context: {
      identity: {
        userId: identity.scope.userId,
        workspaceId: identity.scope.workspaceId,
        agentId: identity.agentId,
        authMode: readOptionalHeader(request, authModeHeader) ?? "unknown",
        workspaceSource: readOptionalHeader(request, workspaceSourceHeader) ?? "unknown",
      },
      account: workspace
        ? {
            id: workspace.account_id,
            source: workspace.account_source,
          }
        : null,
      user: user
        ? {
            id: user.id,
            email: user.email,
            displayName: user.display_name,
            status: user.status,
          }
        : null,
      workspace: workspace
        ? {
            id: workspace.id,
            name: workspace.name,
            status: workspace.status,
            isDefault: workspace.is_default === 1,
          }
        : null,
      membership: membership
        ? {
            role: membership.role,
            status: membership.status,
            roles: parseStringArray(membership.roles_json),
            permissions: parseStringArray(membership.permissions_json),
          }
        : null,
      agent: agent
        ? {
            id: agent.id,
            name: agent.name,
            status: agent.status,
            isDefault: agent.is_default === 1,
          }
        : null,
    },
  });
};
