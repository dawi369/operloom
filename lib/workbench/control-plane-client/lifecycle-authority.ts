import type { Id } from "@/lib/workbench/core-contracts";
import type {
  CloudflareActionsResponse,
  CloudflareConnectionsResponse,
  CloudflareDataJobResponse,
  CloudflareKillSwitchesResponse,
  CloudflareRetentionPolicyResponse,
  CloudflareWorkspaceDeletionResponse,
} from "@/lib/workbench/workbench-types";
import { requestControlPlane, requestControlPlaneResponse } from "./transport";

export const getCloudflareRetentionPolicy = () =>
  requestControlPlane<CloudflareRetentionPolicyResponse>("/workbench/retention-policy");

export const updateCloudflareRetentionPolicy = (input: {
  artifactRetentionDays: number;
  operationalEventRetentionDays: number;
  runtimeTraceRetentionDays: number;
  chatMessageRetentionDays?: number;
  runPayloadRetentionDays?: number;
  auditActionRetentionDays?: number;
  confirm?: boolean;
}) =>
  requestControlPlane<CloudflareRetentionPolicyResponse>("/workbench/retention-policy", {
    method: "PATCH",
    body: JSON.stringify(input),
  });

export const createCloudflareWorkspaceDataExport = () =>
  requestControlPlane<CloudflareDataJobResponse>("/workbench/data-exports", { method: "POST" });

export const getCloudflareWorkspaceDataJob = (jobId: Id) =>
  requestControlPlane<CloudflareDataJobResponse>(
    `/workbench/data-exports/${encodeURIComponent(jobId)}`,
  );

export const getCloudflareWorkspaceDataExportDownload = (jobId: Id) =>
  requestControlPlaneResponse(`/workbench/data-exports/${encodeURIComponent(jobId)}/download`);

export const getCloudflareConnections = () =>
  requestControlPlane<CloudflareConnectionsResponse>("/workbench/connections");

export const storeCloudflareConnectionCredential = (connectionId: Id, secret: string) =>
  requestControlPlane<CloudflareConnectionsResponse>(
    `/workbench/connections/${encodeURIComponent(connectionId)}/credentials`,
    { method: "POST", body: JSON.stringify({ secret }) },
  );

export const startCloudflareConnectionAuthorization = (connectionId: Id, redirectUri: string) =>
  requestControlPlane<{ ok: true; authorizationUrl: string; expiresAt: string }>(
    `/workbench/connections/${encodeURIComponent(connectionId)}/authorize`,
    { method: "POST", body: JSON.stringify({ redirectUri }) },
  );

export const completeCloudflareConnectionAuthorization = (state: string, code: string) =>
  requestControlPlane<{ ok: true; connectionId: string; status: string }>(
    "/workbench/connections/oauth/callback",
    { method: "POST", body: JSON.stringify({ state, code }) },
  );

export const refreshCloudflareConnection = (connectionId: Id) =>
  requestControlPlane<CloudflareConnectionsResponse>(
    `/workbench/connections/${encodeURIComponent(connectionId)}/refresh`,
    { method: "POST" },
  );

export const checkCloudflareConnectionHealth = (connectionId: Id) =>
  requestControlPlane<CloudflareConnectionsResponse>(
    `/workbench/connections/${encodeURIComponent(connectionId)}/health`,
    { method: "POST" },
  );

export const revokeCloudflareConnection = (connectionId: Id) =>
  requestControlPlane<CloudflareConnectionsResponse>(
    `/workbench/connections/${encodeURIComponent(connectionId)}`,
    { method: "DELETE" },
  );

export const getCloudflareActions = (limit = 25) =>
  requestControlPlane<CloudflareActionsResponse>(
    `/workbench/actions?limit=${encodeURIComponent(String(limit))}`,
  );

export const requestCloudflareActionExecution = (proposalId: Id) =>
  requestControlPlane<CloudflareActionsResponse>(
    `/workbench/actions/${encodeURIComponent(proposalId)}/execute`,
    { method: "POST" },
  );

export const reconcileCloudflareAction = (proposalId: Id) =>
  requestControlPlane<CloudflareActionsResponse>(
    `/workbench/actions/${encodeURIComponent(proposalId)}/reconcile`,
    { method: "POST" },
  );

export const requestCloudflareWorkspaceDeletion = (input: {
  workspaceName: string;
  reauthenticatedAt: string;
}) =>
  requestControlPlane<CloudflareWorkspaceDeletionResponse>("/workbench/workspace-deletion", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const getCloudflareWorkspaceDeletion = () =>
  requestControlPlane<CloudflareWorkspaceDeletionResponse>("/workbench/workspace-deletion");

export const recoverCloudflareWorkspace = () =>
  requestControlPlane<CloudflareWorkspaceDeletionResponse>("/workbench/workspace-deletion", {
    method: "DELETE",
  });

export const retryCloudflareWorkspaceDeletion = (input: {
  workspaceName: string;
  reauthenticatedAt: string;
}) =>
  requestControlPlane<CloudflareWorkspaceDeletionResponse>("/workbench/workspace-deletion/retry", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const retryCloudflareWorkspaceDeletionAsOperator = (
  workspaceId: Id,
  input: { workspaceName: string; reason: string },
) =>
  requestControlPlane<CloudflareWorkspaceDeletionResponse>(
    `/admin/workspace-purges/${encodeURIComponent(workspaceId)}/retry`,
    { method: "POST", body: JSON.stringify(input) },
  );

export const getCloudflareKillSwitches = () =>
  requestControlPlane<CloudflareKillSwitchesResponse>("/workbench/kill-switches");

export const updateCloudflareKillSwitch = (input: {
  scopeKind: "workspace" | "pack" | "tool" | "connection";
  scopeId: string;
  enabled: boolean;
  reason: string;
}) =>
  requestControlPlane<CloudflareKillSwitchesResponse>("/workbench/kill-switches", {
    method: "PUT",
    body: JSON.stringify(input),
  });
