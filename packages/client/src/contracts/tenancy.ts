import type { Id } from "../core-contracts.js";

export type WorkspaceSummary = {
  id: Id;
  name: string;
  status: string;
  isDefault: boolean;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type CloudflareWorkspacesResponse = {
  ok?: boolean;
  account?: {
    id: Id;
    source: string;
  };
  activeWorkspaceId?: Id;
  workspaces?: WorkspaceSummary[];
  error?: string;
};

export type CloudflareWorkspaceMutationResponse = {
  ok?: boolean;
  activeWorkspaceId?: Id;
  workspace?: WorkspaceSummary | null;
  defaultAgent?: {
    id: Id;
    name: string;
    status: string;
    isDefault: boolean;
  } | null;
  agent?: {
    id: Id;
    name: string;
    status: string;
    isDefault: boolean;
  } | null;
  error?: string;
};

export type WorkspaceMemberSummary = {
  id: Id;
  userId: Id;
  email?: string;
  displayName: string;
  role: "owner" | "admin" | "member" | string;
  roles: string[];
  permissions: string[];
  status: "active" | "disabled" | string;
  userStatus?: string;
  isCurrentUser: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type CloudflareWorkspaceMembersResponse = {
  ok?: boolean;
  workspace?: Pick<WorkspaceSummary, "id" | "name">;
  currentMembership?: WorkspaceMemberSummary | null;
  members?: WorkspaceMemberSummary[];
  availableMembers?: WorkspaceMemberSummary[];
  error?: string;
};

export type CloudflareWorkspaceMemberMutationResponse = {
  ok?: boolean;
  member?: WorkspaceMemberSummary;
  error?: string;
};

export type WorkbenchAccountContextResponse = {
  ok?: boolean;
  currentAccountId?: Id;
  currentOrganizationId?: Id;
  accounts?: Array<{
    id: Id;
    organizationId?: Id;
    name: string;
    source: "workos-organization" | "workos-personal" | "local-dev";
    role?: string;
    roles?: string[];
    isCurrent: boolean;
  }>;
  error?: string;
};
