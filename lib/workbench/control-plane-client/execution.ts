import { agentManifestRegistry } from "@/generated/agent-runtime/manifests";
import type { Id } from "@/lib/workbench/core-contracts";
import {
  adminSummaryProjectionPath,
  type AdminSummaryProjection,
} from "@/lib/workbench/admin-summary-projection";
import type {
  CloudflareAdminSummaryResponse,
  CloudflareArtifactBlobResponse,
  CloudflareArtifactHistoryResponse,
  CloudflareExecutionHistoryResponse,
  CloudflareExecutionHistoryRunResponse,
  CloudflareRuntimeTraceResponse,
  CloudflareRuntimeTracesResponse,
  CloudflareToolApprovalActionResponse,
  CloudflareToolApprovalsResponse,
  CloudflareToolPolicyUpdateResponse,
  CloudflareToolRunResponse,
  CloudflareToolsResponse,
  ControlPlaneEventsResponse,
  CreateArtifactBlobInput,
  WorkspaceContextResponse,
} from "@/lib/workbench/workbench-types";
import {
  controlPlaneRequest,
  fetchWithTimeout,
  parseErrorBody,
  requestControlPlane,
  requestControlPlaneResponse,
  ControlPlaneRequestError,
} from "./transport";

export const getWorkspaceContext = () =>
  requestControlPlane<WorkspaceContextResponse>("/workspace-context");

export const getCloudflareAdminSummary = (input?: { projection?: AdminSummaryProjection }) =>
  requestControlPlane<CloudflareAdminSummaryResponse>(
    adminSummaryProjectionPath(input?.projection),
  );

export const getCloudflareTools = (input?: {
  stage?: "observe" | "analyze" | "propose" | "execute" | "review";
  executionMode?: "ask" | "dry_run" | "execute";
  surface?: "admin_list" | "admin_run" | "admin_resume" | "model_exposure" | "model_tool_call";
  featureFlags?: string;
}) => {
  const params = new URLSearchParams();
  if (input?.stage) params.set("stage", input.stage);
  if (input?.executionMode) params.set("executionMode", input.executionMode);
  if (input?.surface) params.set("surface", input.surface);
  if (input?.featureFlags) params.set("featureFlags", input.featureFlags);
  const query = params.toString();
  return requestControlPlane<CloudflareToolsResponse>(`/tools${query ? `?${query}` : ""}`);
};

export const getCloudflareToolApprovals = (input?: {
  status?: "requested" | "decided" | "all";
  limit?: number;
}) => {
  const params = new URLSearchParams();
  if (input?.status) params.set("status", input.status);
  if (input?.limit) params.set("limit", String(input.limit));
  const query = params.toString();
  return requestControlPlane<CloudflareToolApprovalsResponse>(
    `/tools/approvals${query ? `?${query}` : ""}`,
  );
};

export const getLatestRuntimeTraces = (limit = 10) =>
  requestControlPlane<CloudflareRuntimeTracesResponse>(
    `/runtime/traces/latest?limit=${encodeURIComponent(String(limit))}`,
  );

export const getRuntimeTrace = (traceId: Id) =>
  requestControlPlane<CloudflareRuntimeTraceResponse>(
    `/runtime/traces/${encodeURIComponent(traceId)}`,
  );

export const getExecutionHistory = (limit = 25) =>
  requestControlPlane<CloudflareExecutionHistoryResponse>(
    `/workbench/history/runs?limit=${encodeURIComponent(String(limit))}`,
  );

export const getExecutionHistoryRun = (runId: Id) =>
  requestControlPlane<CloudflareExecutionHistoryRunResponse>(
    `/workbench/history/runs/${encodeURIComponent(runId)}`,
  );

export const cancelCloudflareExecutionRun = (runId: Id) =>
  requestControlPlane<{ ok?: boolean; run?: { id?: Id; status?: string }; error?: string }>(
    `/workbench/history/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
  );

export const retryCloudflareExecutionRun = (runId: Id) =>
  requestControlPlane<CloudflareToolRunResponse>(
    `/workbench/history/runs/${encodeURIComponent(runId)}/retry`,
    { method: "POST" },
  );

export const getArtifactHistory = (limit = 25) =>
  requestControlPlane<CloudflareArtifactHistoryResponse>(
    `/workbench/history/artifacts?limit=${encodeURIComponent(String(limit))}`,
  );

export const createCloudflareArtifactBlob = (input: CreateArtifactBlobInput) =>
  requestControlPlane<CloudflareArtifactBlobResponse>("/workbench/artifacts", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const getCloudflareArtifactContentResponse = (artifactId: Id) =>
  requestControlPlaneResponse(`/workbench/artifacts/${encodeURIComponent(artifactId)}/content`);

export type RunnableAdminToolName = string;

export const runCloudflareTool = (input: {
  toolName: RunnableAdminToolName;
  executionMode?: "dry_run";
  input: Record<string, unknown>;
  parentRunId?: Id;
}) =>
  requestControlPlane<CloudflareToolRunResponse>("/tools/runs", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const runPackWorkflow = (
  workflowType: string,
  input: {
    executionMode?: "dry_run";
    input: Record<string, unknown>;
  },
) =>
  requestControlPlane<CloudflareToolRunResponse & { report?: unknown }>(
    `/workbench/workflows/${encodeURIComponent(workflowType)}`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    // Synchronous workflows must outlive their execution budget and result persistence.
    ((Object.values(agentManifestRegistry).find(({ module }) =>
      module.workflows.some((workflow) => workflow.type === workflowType),
    )?.module.resourceLimits.maxRunSeconds ?? 30) +
      15) *
      1000,
  );

export const updateCloudflareToolPolicy = (input: {
  toolName: string;
  status?: "enabled" | "disabled";
  requiresApproval?: boolean;
  mutationEnabled?: boolean;
  killSwitchReason?: string;
  modelVisible?: boolean;
  approvalReason?: string;
  allowedExecutionModes?: Array<"ask" | "dry_run" | "execute">;
  limits?: {
    perUserPerHour?: number;
    perWorkspacePerHour?: number;
  };
  cooldownSeconds?: number | null;
  allowlist?: string[];
  denylist?: string[];
  maxRuntimeMs?: number | null;
  maxArtifactBytes?: number | null;
}) =>
  requestControlPlane<CloudflareToolPolicyUpdateResponse>("/tools/policy", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const approveCloudflareToolApproval = (approvalRequestId: Id) =>
  requestControlPlane<CloudflareToolApprovalActionResponse>(
    `/tools/approvals/${encodeURIComponent(approvalRequestId)}/approve`,
    {
      method: "POST",
    },
  );

export const denyCloudflareToolApproval = (approvalRequestId: Id, input?: { reason?: string }) =>
  requestControlPlane<CloudflareToolApprovalActionResponse>(
    `/tools/approvals/${encodeURIComponent(approvalRequestId)}/deny`,
    {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    },
  );

export const getLatestControlPlaneEvents = (limit = 50) =>
  requestControlPlane<ControlPlaneEventsResponse>(
    `/events/latest?limit=${encodeURIComponent(String(limit))}`,
  );

export const streamControlPlaneEvents = async (
  after?: string | null,
  lastEventId?: string | null,
) => {
  const searchParams = new URLSearchParams();
  if (after) searchParams.set("after", after);
  const queryString = searchParams.toString() ? `?${searchParams.toString()}` : "";
  const request = await controlPlaneRequest(`/events/stream${queryString}`, {
    headers: {
      accept: "text/event-stream",
      ...(lastEventId && !after ? { "Last-Event-ID": lastEventId } : {}),
    },
  });
  const response = await fetchWithTimeout(request.url, request.init);

  if (!response.ok) {
    throw new ControlPlaneRequestError(await parseErrorBody(response), response.status);
  }

  return response;
};
