import type { Id } from "../core-contracts.js";

export type WorkbenchWorkflowDescriptor = {
  type: string;
  label: string;
  description?: string;
  engine: "cloudflare";
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  toolIds: string[];
  runDisplayName?: string;
};

export type WorkbenchWorkflowDiscoveryResponse = {
  ok: boolean;
  packId?: Id;
  packVersion?: string;
  runtimeVersion?: string;
  runnable: boolean;
  reason?: string;
  workflows: WorkbenchWorkflowDescriptor[];
  error?: string;
};

export type TriggerSummary = {
  id: Id;
  publicId?: string;
  agentId: Id;
  packId: string;
  packTriggerId: string;
  kind: "schedule" | "monitor" | "webhook";
  workflowType: string;
  status: "enabled" | "paused" | "disabled";
  execution: Record<string, unknown>;
  config: Record<string, unknown>;
  input: Record<string, unknown>;
  maxConcurrentRuns: number;
  version: number;
  nextTriggerAt?: string;
  lastTriggeredAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateTriggerInput = {
  packId: string;
  packTriggerId: string;
  status?: "enabled" | "paused";
  execution?: "request" | "durable";
  input?: Record<string, unknown>;
};

export type UpdateTriggerInput = {
  expectedVersion: number;
  status?: "enabled" | "paused" | "disabled";
  input?: Record<string, unknown>;
};

export type CreateTriggerDispatchInput = {
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  scheduledFor?: string;
};

export type TriggerDispatchSummary = {
  id: Id;
  triggerId: Id;
  agentId: Id;
  idempotencyKey: string;
  source: "manual" | "schedule" | "monitor" | "webhook" | "replay";
  status: "pending" | "leased" | "running" | "completed" | "failed" | "cancelled";
  attemptCount: number;
  runId?: Id;
  previousRunId?: Id;
  scheduledFor?: string;
  receivedAt: string;
  payload: Record<string, unknown>;
  error: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ManagedStateSummary = {
  id: Id;
  agentId: Id;
  namespace: string;
  stateType: string;
  stateKey: string;
  type: string;
  name: string;
  status: string;
  summary?: string;
  version: number;
  artifactRefs: Id[];
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CloudflareTriggersResponse = {
  ok?: boolean;
  triggers?: TriggerSummary[];
  trigger?: TriggerSummary;
  created?: boolean;
  webhookSecret?: string;
  limit?: number;
  error?: string;
};

export type OperatorAlertSummary = {
  id: Id;
  severity: "warning" | "critical";
  code: string;
  summary: string;
  targetType?: string;
  targetId?: Id;
  status: "open" | "acknowledged" | "resolved";
  deliveryStatus: "pending" | "delivered" | "failed";
  deliveryAttempts: number;
  lastDeliveryAt?: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CloudflareOperatorAlertsResponse = {
  ok?: boolean;
  alerts?: OperatorAlertSummary[];
  alert?: {
    id: Id;
    status?: OperatorAlertSummary["status"];
    deliveryStatus?: OperatorAlertSummary["deliveryStatus"];
    updatedAt: string;
  };
  limit?: number;
  error?: string;
};

export type CloudflareTriggerDispatchesResponse = {
  ok?: boolean;
  dispatches?: TriggerDispatchSummary[];
  dispatch?: Partial<TriggerDispatchSummary> &
    Pick<TriggerDispatchSummary, "id" | "triggerId" | "status" | "attemptCount">;
  created?: boolean;
  duplicate?: boolean;
  limit?: number;
  error?: string;
};

export type CloudflareManagedStateResponse = {
  ok?: boolean;
  states?: ManagedStateSummary[];
  state?: ManagedStateSummary;
  limit?: number;
  error?: string;
};
