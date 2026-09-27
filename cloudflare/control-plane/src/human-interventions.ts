import type { ControlApprovalRequestRow } from "./types";
import type { WorkflowReviewDescriptor } from "@operloom/workbench-client";
import { isRecord, parseDataJson } from "./http";

export const workflowReviewDescriptor = (
  dataJson: string,
): WorkflowReviewDescriptor | undefined => {
  const data = parseDataJson(dataJson);
  if (
    data.kind !== "durable_workflow" ||
    !isRecord(data.payload) ||
    typeof data.requestHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.requestHash) ||
    typeof data.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(data.expiresAt))
  )
    return undefined;
  return { payload: data.payload, requestHash: data.requestHash, expiresAt: data.expiresAt };
};

export type HumanInterventionStatus = "requested" | "approved" | "denied" | "failed" | string;

export type HumanInterventionSummary = {
  id: string;
  kind: "approval";
  status: HumanInterventionStatus;
  state: "parked" | "resumable" | "decided";
  requiredAction: "approve_or_deny" | "none";
  resumeSurface: "admin_resume";
  runId: string;
  workflowIntentId: string;
  toolId: string;
  reason: string;
  title: string;
  review?: WorkflowReviewDescriptor;
  approvePath?: string;
  denyPath?: string;
  currentPolicy?: {
    decision?: "allow" | "block";
    code?: string;
    reason?: string;
  };
  createdAt: string;
  updatedAt: string;
};

const stateForStatus = (status: HumanInterventionStatus) => {
  if (status === "requested") return "parked";
  if (status === "approved") return "resumable";
  return "decided";
};

export const toHumanInterventionSummary = (
  approval: ControlApprovalRequestRow,
  input?: {
    status?: string;
    currentPolicy?: HumanInterventionSummary["currentPolicy"];
  },
): HumanInterventionSummary => {
  const status = input?.status ?? approval.status;
  const state = stateForStatus(status);
  const review = workflowReviewDescriptor(approval.data_json);
  return {
    id: approval.id,
    kind: "approval",
    status,
    state,
    requiredAction: status === "requested" ? "approve_or_deny" : "none",
    resumeSurface: "admin_resume",
    runId: approval.run_id,
    workflowIntentId: approval.workflow_intent_id,
    toolId: approval.tool_id,
    reason: approval.reason,
    title: review ? "Workflow review" : `${approval.tool_id} approval`,
    review,
    approvePath:
      status === "requested"
        ? `/tools/approvals/${encodeURIComponent(approval.id)}/approve`
        : undefined,
    denyPath:
      status === "requested"
        ? `/tools/approvals/${encodeURIComponent(approval.id)}/deny`
        : undefined,
    currentPolicy: input?.currentPolicy,
    createdAt: approval.created_at,
    updatedAt: approval.updated_at,
  };
};

export const toHumanInterventionEventData = (input: {
  approvalRequestId: string;
  status: string;
  runId?: string;
  workflowIntentId?: string;
  toolName?: string;
  reason?: string;
}) => ({
  id: input.approvalRequestId,
  kind: "approval",
  status: input.status,
  state: stateForStatus(input.status),
  requiredAction: input.status === "requested" ? "approve_or_deny" : "none",
  resumeSurface: "admin_resume",
  approvalRequestId: input.approvalRequestId,
  runId: input.runId,
  workflowIntentId: input.workflowIntentId,
  toolId: input.toolName,
  reason: input.reason,
});
