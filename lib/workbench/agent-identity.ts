import { withAuth } from "@workos-inc/authkit-nextjs";
import { headers } from "next/headers";

import { getAuthConfiguration } from "./auth-configuration";
import type { Id } from "@/lib/workbench/core-contracts";
import { resolveWorkbenchAgentIdentity } from "./agent-identity-resolution";
import { WorkbenchAuthError, type WorkbenchAgentIdentity } from "./agent-identity-types";

export { WorkbenchAuthError, type WorkbenchAgentIdentity } from "./agent-identity-types";

const requiredEnv = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
};

const getDevAgentId = () => requiredEnv("WORKBENCH_DEV_AGENT_ID");

const getDevAgentIdentity = (): WorkbenchAgentIdentity => ({
  scope: {
    userId: requiredEnv("WORKBENCH_DEV_USER_ID"),
    workspaceId: requiredEnv("WORKBENCH_DEV_WORKSPACE_ID"),
  },
  agentId: getDevAgentId(),
  authMode: "local-dev",
  accountId: `local-dev:${requiredEnv("WORKBENCH_DEV_WORKSPACE_ID")}`,
  accountSource: "local-dev",
  workspaceSource: "local-dev",
});

const getWorkOsOrgAccountId = (organizationId: Id): Id => `workos-org:${organizationId}`;
const getPersonalAccountId = (userId: Id): Id => `workos-personal:${userId}`;
const getDefaultWorkspaceId = (accountId: Id): Id => `workspace:${accountId}:default`;

const getCookieOrDevIdentity = async (): Promise<WorkbenchAgentIdentity> => {
  const { workOsConfigured, localIdentityEnabled } = getAuthConfiguration();
  if (!workOsConfigured) {
    if (!localIdentityEnabled) {
      throw new WorkbenchAuthError(
        "WorkOS is not configured and local-dev workbench identity fallback is disabled",
        500,
      );
    }
    return getDevAgentIdentity();
  }

  const auth = await withAuth();
  if (!auth.user) throw new WorkbenchAuthError("Authentication required", 401);

  const userName = [auth.user.firstName, auth.user.lastName].filter(Boolean).join(" ");
  const hasOrganization = Boolean(auth.organizationId);
  const accountId = auth.organizationId
    ? getWorkOsOrgAccountId(auth.organizationId)
    : getPersonalAccountId(auth.user.id);
  const accountSource = hasOrganization ? "workos-organization" : "workos-personal";

  return {
    scope: {
      userId: auth.user.id,
      workspaceId: getDefaultWorkspaceId(accountId),
    },
    authMode: "workos",
    accountId,
    accountSource,
    workspaceSource: accountSource,
    organizationId: auth.organizationId,
    userEmail: auth.user.email,
    userName: userName || auth.user.email || auth.user.id,
    membershipRole: auth.role ?? (hasOrganization ? undefined : "owner"),
    membershipRoles: auth.roles ?? (hasOrganization ? undefined : ["owner"]),
    membershipPermissions: auth.permissions,
  };
};

export const getWorkbenchAgentIdentity = async (): Promise<WorkbenchAgentIdentity> =>
  resolveWorkbenchAgentIdentity({
    authorization: (await headers()).get("authorization"),
    cookieIdentity: getCookieOrDevIdentity,
  });

export const getWorkbenchIdentityHeaders = async () => {
  const identity = await getWorkbenchAgentIdentity();
  const headers: Record<string, string> = {
    "x-assistant-mk1-user-id": identity.scope.userId,
    "x-assistant-mk1-account-id": identity.accountId,
    "x-assistant-mk1-account-source": identity.accountSource,
    "x-assistant-mk1-auth-mode": identity.authMode,
    "x-assistant-mk1-workspace-source": identity.workspaceSource,
  };

  if (identity.authMode === "local-dev" || identity.agentId) {
    headers["x-assistant-mk1-workspace-id"] = identity.scope.workspaceId;
  }
  if (identity.agentId) headers["x-assistant-mk1-agent-id"] = identity.agentId;
  if (identity.userEmail) headers["x-assistant-mk1-user-email"] = identity.userEmail;
  if (identity.userName) headers["x-assistant-mk1-user-name"] = identity.userName;
  if (identity.membershipRole) headers["x-assistant-mk1-membership-role"] = identity.membershipRole;
  if (identity.membershipRoles) {
    headers["x-assistant-mk1-membership-roles"] = JSON.stringify(identity.membershipRoles);
  }
  if (identity.membershipPermissions) {
    headers["x-assistant-mk1-membership-permissions"] = JSON.stringify(
      identity.membershipPermissions,
    );
  }

  return headers;
};
