import type { Id, TenantScope } from "@/lib/workbench/core-contracts";

export type WorkbenchAgentIdentity = {
  scope: TenantScope;
  agentId?: Id;
  authMode: "local-dev" | "workos";
  accountId: Id;
  accountSource: "local-dev" | "workos-organization" | "workos-personal";
  workspaceSource: "local-dev" | "workos-organization" | "workos-personal";
  organizationId?: Id;
  sessionId?: Id;
  /** Signed identity-provider auth_time; never supplied by a client body. */
  verifiedAuthenticationTime?: number;
  userEmail?: string;
  userName?: string;
  membershipRole?: string;
  membershipRoles?: string[];
  membershipPermissions?: string[];
};

export class WorkbenchAuthError extends Error {
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
    this.name = "WorkbenchAuthError";
  }
}
