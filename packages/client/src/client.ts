import type {
  AgentSwitchTarget,
  ChatSessionResponse,
  ChatThreadsResponse,
  CloudflareActionsResponse,
  CloudflareAgentMutationResponse,
  CloudflareAgentsResponse,
  CloudflareArtifactHistoryResponse,
  CloudflareConnectionsResponse,
  CloudflareClientDevicesResponse,
  CloudflareNotificationPreferencesResponse,
  ConnectionAuthorizationResponse,
  CloudflareExecutionHistoryResponse,
  CloudflareExecutionHistoryRunResponse,
  CloudflareManagedStateResponse,
  CloudflareToolApprovalActionResponse,
  CloudflareToolApprovalsResponse,
  CloudflareToolRunResponse,
  CloudflareWorkspaceMutationResponse,
  CloudflareWorkspacesResponse,
  ExecutionRunResponse,
  Id,
  WorkbenchAccountContextResponse,
  WorkbenchWorkflowDiscoveryResponse,
} from "./contracts/index.js";
import {
  isJsonObject,
  parseWorkbenchResponse,
  WorkbenchResponseValidationError,
} from "./validation.js";
import { responseSchemas, type ResponseSchemaName } from "./response-schemas.js";
import {
  ConsoleOnlyOperationError,
  resolveTargetPath,
  type WorkbenchClientTarget,
} from "./route-map.js";
import type { z } from "zod";
import type { publicBillingContracts } from "./public-billing-contracts.js";
import type {
  AdminMemoryRecord,
  MemoryKind,
  MemoryPolicyView,
  MemoryRecord,
} from "./public-memory-contracts.js";
import type { AdminEvent } from "./public-admin-contracts.js";

export type WorkbenchClientPlatform = "web" | "ios" | "android";

export type WorkbenchClientOptions = {
  /** Console: a Next.js origin (or "" for same-origin). Control plane: the Worker's `/v1/me` URL. */
  baseUrl: string;
  /** Defaults to `console`; `control-plane` maps every operation to its `/v1/me` path. */
  target?: WorkbenchClientTarget;
  getAccessToken?: (input?: { minValidityMs?: number }) => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
  client: { platform: WorkbenchClientPlatform; version: string };
  timeoutMs?: number;
};

export class WorkbenchClientError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly runId?: string;
  readonly retryable: boolean;

  constructor(input: {
    message: string;
    status: number;
    code?: string;
    requestId?: string;
    runId?: string;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = "WorkbenchClientError";
    this.status = input.status;
    this.code = input.code;
    this.requestId = input.requestId;
    this.runId = input.runId;
    this.retryable = input.retryable ?? (input.status === 0 || input.status >= 500);
  }
}

export type WorkbenchRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: HeadersInit;
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type WorkbenchReadOptions = { signal?: AbortSignal };

const normalizedBaseUrl = (value: string) => value.trim().replace(/\/$/, "");
const requestUrl = (baseUrl: string, path: string) =>
  baseUrl ? `${baseUrl}${path.startsWith("/") ? path : `/${path}`}` : path;

const errorFromBody = (body: unknown) => {
  if (!isJsonObject(body)) return {};
  return {
    runId: typeof body.runId === "string" ? body.runId : undefined,
    code: typeof body.code === "string" ? body.code : undefined,
    message: typeof body.error === "string" ? body.error : undefined,
    retryable: typeof body.retryable === "boolean" ? body.retryable : undefined,
  };
};

const queryString = (input: Record<string, string | number | undefined>) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const value = query.toString();
  return value ? `?${value}` : "";
};

export const createWorkbenchClient = (options: WorkbenchClientOptions) => {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new TypeError("A fetch implementation is required");
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  const target = options.target ?? "console";
  const defaultTimeoutMs = options.timeoutMs ?? 15_000;

  const request = async <T>(
    schemaName: ResponseSchemaName,
    path: string,
    requestOptions: WorkbenchRequestOptions = {},
  ): Promise<T> => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Workbench request timed out")),
      requestOptions.timeoutMs ?? defaultTimeoutMs,
    );
    const abortFromCaller = () => controller.abort(requestOptions.signal?.reason);
    if (requestOptions.signal?.aborted) abortFromCaller();
    else requestOptions.signal?.addEventListener("abort", abortFromCaller, { once: true });

    let upstreamRequestId: string | undefined;
    try {
      let targetPath: string;
      try {
        targetPath = resolveTargetPath(target, path);
      } catch (error) {
        if (error instanceof ConsoleOnlyOperationError)
          throw new WorkbenchClientError({ status: 0, code: error.code, message: error.message });
        throw error;
      }
      const token = await options.getAccessToken?.({ minValidityMs: 60_000 });
      const headers = new Headers(requestOptions.headers);
      headers.set("accept", "application/json");
      headers.set("x-operloom-client-platform", options.client.platform);
      headers.set("x-operloom-client-version", options.client.version);
      if (token) headers.set("authorization", `Bearer ${token}`);
      if (requestOptions.body !== undefined) headers.set("content-type", "application/json");
      if (requestOptions.idempotencyKey) {
        headers.set("idempotency-key", requestOptions.idempotencyKey);
      }

      const response = await fetcher(requestUrl(baseUrl, targetPath), {
        method: requestOptions.method ?? "GET",
        headers,
        body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
        cache: "no-store",
        credentials: token ? "omit" : "include",
        signal: controller.signal,
      });
      const requestId = response.headers.get("x-request-id") ?? undefined;
      upstreamRequestId = requestId;
      const body = (await response.json().catch(() => ({}))) as unknown;
      if (!response.ok) {
        const parsed = errorFromBody(body);
        throw new WorkbenchClientError({
          status: response.status,
          requestId,
          code: parsed.code,
          runId: parsed.runId,
          retryable: parsed.retryable,
          message: parsed.message ?? `Workbench request failed (${response.status})`,
        });
      }
      return parseWorkbenchResponse<T>(responseSchemas[schemaName], body, path);
    } catch (error) {
      if (error instanceof WorkbenchClientError) throw error;
      if (error instanceof WorkbenchResponseValidationError) {
        throw new WorkbenchClientError({
          status: 0,
          code: "invalid_response",
          requestId: upstreamRequestId,
          message: error.message,
          retryable: false,
        });
      }
      if (controller.signal.aborted) {
        throw new WorkbenchClientError({
          status: 0,
          code: requestOptions.signal?.aborted ? "request_cancelled" : "request_timeout",
          message: requestOptions.signal?.aborted
            ? "Workbench request was cancelled"
            : "Workbench request timed out",
          retryable: !requestOptions.signal?.aborted,
        });
      }
      throw new WorkbenchClientError({
        status: 0,
        code: "network_error",
        message: error instanceof Error ? error.message : "Workbench network request failed",
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
      requestOptions.signal?.removeEventListener("abort", abortFromCaller);
    }
  };

  return {
    session: {
      get: (input: { refresh?: "threads"; source?: string; signal?: AbortSignal } = {}) =>
        request<ChatSessionResponse>(
          "session",
          `/api/workbench/chat-session${queryString({ refresh: input.refresh, source: input.source })}`,
          { signal: input.signal },
        ),
      stageThread: (input: { source?: string } = {}) =>
        request<ChatSessionResponse>(
          "session",
          `/api/workbench/chat-session/stage-thread${queryString({ source: input.source })}`,
          { method: "POST" },
        ),
      materializeTurn: (input: { text: string; clientTurnId: Id; clientWarmSession?: boolean }) =>
        request<ChatSessionResponse>("session", "/api/workbench/chat-session/materialize-turn", {
          method: "POST",
          idempotencyKey: input.clientTurnId,
          body: {
            message: input.text,
            clientTurnId: input.clientTurnId,
            clientWarmSession: input.clientWarmSession,
          },
        }),
      switchAgent: (input: { agentId: Id; target: AgentSwitchTarget; threadId?: Id }) =>
        request<ChatSessionResponse>("session", "/api/workbench/chat-session/agent-switch", {
          method: "POST",
          body: input,
        }),
    },
    threads: {
      list: (status: "active" | "archived" = "active", options: WorkbenchReadOptions = {}) =>
        request<ChatThreadsResponse>(
          "threads",
          `/api/workbench/chat-session/threads${queryString({ status })}`,
          options,
        ),
      create: (title?: string) =>
        request<ChatSessionResponse>("session", "/api/workbench/chat-session/threads", {
          method: "POST",
          body: title ? { title } : {},
        }),
      activate: (threadId: Id) =>
        request<ChatSessionResponse>(
          "session",
          `/api/workbench/chat-session/threads/${encodeURIComponent(threadId)}/activate`,
          { method: "POST" },
        ),
      update: (
        threadId: Id,
        input: {
          title?: string;
          status?: "active" | "archived" | "deleted";
          fallbackTitle?: string;
        },
      ) =>
        request<ChatSessionResponse>(
          "session",
          `/api/workbench/chat-session/threads/${encodeURIComponent(threadId)}`,
          { method: "PATCH", body: input },
        ),
    },
    workspaces: {
      listAccounts: (options: WorkbenchReadOptions = {}) =>
        request<WorkbenchAccountContextResponse>("accounts", "/api/workbench/accounts", options),
      list: (options: WorkbenchReadOptions = {}) =>
        request<CloudflareWorkspacesResponse>("workspaces", "/api/workbench/workspaces", options),
      activate: (workspaceId: Id) =>
        request<CloudflareWorkspaceMutationResponse>(
          "workspaceMutation",
          `/api/workbench/workspaces/${encodeURIComponent(workspaceId)}/activate`,
          { method: "POST" },
        ),
    },
    agents: {
      list: (options: WorkbenchReadOptions = {}) =>
        request<CloudflareAgentsResponse>("agents", "/api/workbench/agents", options),
      activate: (agentId: Id) =>
        request<CloudflareAgentMutationResponse>(
          "agentMutation",
          `/api/workbench/agents/${encodeURIComponent(agentId)}/activate`,
          { method: "POST" },
        ),
      instantiatePack: (packId: Id) =>
        request<CloudflareAgentMutationResponse>(
          "agentMutation",
          `/api/workbench/agent-packs/${encodeURIComponent(packId)}/instantiate`,
          { method: "POST" },
        ),
    },
    workflows: {
      list: (options: WorkbenchReadOptions = {}) =>
        request<WorkbenchWorkflowDiscoveryResponse>(
          "workflows",
          "/api/workbench/workflows",
          options,
        ),
      run: (
        workflowType: string,
        input: { input?: Record<string, unknown>; executionMode?: "dry_run" } = {},
      ) =>
        request<CloudflareToolRunResponse>(
          "toolRun",
          `/api/workbench/workflows/${encodeURIComponent(workflowType)}`,
          {
            method: "POST",
            body: input,
            // Workflow execution includes cold compute and durable result publication.
            timeoutMs: options.timeoutMs ?? 180_000,
          },
        ),
    },
    history: {
      listRuns: (input: { limit?: number; signal?: AbortSignal } = {}) =>
        request<CloudflareExecutionHistoryResponse>(
          "runList",
          `/api/workbench/history/runs${queryString({ limit: input.limit })}`,
          { signal: input.signal },
        ),
      getRun: (runId: Id, options: WorkbenchReadOptions = {}) =>
        request<CloudflareExecutionHistoryRunResponse>(
          "runDetail",
          `/api/workbench/history/runs/${encodeURIComponent(runId)}`,
          options,
        ),
      listArtifacts: (input: { limit?: number; signal?: AbortSignal } = {}) =>
        request<CloudflareArtifactHistoryResponse>(
          "artifacts",
          `/api/workbench/history/artifacts${queryString({ limit: input.limit })}`,
          { signal: input.signal },
        ),
      cancel: (runId: Id) =>
        request<ExecutionRunResponse>(
          "executionRun",
          `/api/workbench/history/runs/${encodeURIComponent(runId)}/cancel`,
          { method: "POST" },
        ),
      retry: (runId: Id) =>
        request<ExecutionRunResponse>(
          "executionRun",
          `/api/workbench/history/runs/${encodeURIComponent(runId)}/retry`,
          { method: "POST" },
        ),
    },
    approvals: {
      list: (options: WorkbenchReadOptions = {}) =>
        request<CloudflareToolApprovalsResponse>(
          "approvals",
          "/api/workbench/tools/approvals",
          options,
        ),
      approve: (approvalRequestId: Id) =>
        request<CloudflareToolApprovalActionResponse>(
          "toolRun",
          `/api/workbench/tools/approvals/${encodeURIComponent(approvalRequestId)}/approve`,
          { method: "POST" },
        ),
      deny: (approvalRequestId: Id, reason = "Denied by user") =>
        request<CloudflareToolApprovalActionResponse>(
          "toolRun",
          `/api/workbench/tools/approvals/${encodeURIComponent(approvalRequestId)}/deny`,
          { method: "POST", body: { reason } },
        ),
    },
    connections: {
      list: (options: WorkbenchReadOptions = {}) =>
        request<CloudflareConnectionsResponse>(
          "connections",
          "/api/workbench/connections",
          options,
        ),
      authorize: (connectionId: Id) =>
        request<ConnectionAuthorizationResponse>(
          "connectionAuthorization",
          `/api/workbench/connections/${encodeURIComponent(connectionId)}/authorize`,
          { method: "POST" },
        ),
      submitCredential: (connectionId: Id, secret: string) =>
        request<CloudflareConnectionsResponse>(
          "connections",
          `/api/workbench/connections/${encodeURIComponent(connectionId)}/credentials`,
          { method: "POST", body: { secret } },
        ),
      refresh: (connectionId: Id) =>
        request<CloudflareConnectionsResponse>(
          "connections",
          `/api/workbench/connections/${encodeURIComponent(connectionId)}/refresh`,
          { method: "POST" },
        ),
      health: (connectionId: Id) =>
        request<CloudflareConnectionsResponse>(
          "connections",
          `/api/workbench/connections/${encodeURIComponent(connectionId)}/health`,
          { method: "POST" },
        ),
      revoke: (connectionId: Id) =>
        request<CloudflareConnectionsResponse>(
          "connections",
          `/api/workbench/connections/${encodeURIComponent(connectionId)}`,
          { method: "DELETE" },
        ),
    },
    actions: {
      list: (input: { limit?: number; signal?: AbortSignal } = {}) =>
        request<CloudflareActionsResponse>(
          "actions",
          `/api/workbench/actions${queryString({ limit: input.limit })}`,
          { signal: input.signal },
        ),
      execute: (proposalId: Id) =>
        request<CloudflareActionsResponse>(
          "actions",
          `/api/workbench/actions/${encodeURIComponent(proposalId)}/execute`,
          { method: "POST" },
        ),
      reconcile: (proposalId: Id) =>
        request<CloudflareActionsResponse>(
          "actions",
          `/api/workbench/actions/${encodeURIComponent(proposalId)}/reconcile`,
          { method: "POST" },
        ),
    },
    managedState: {
      list: (
        input: { namespace?: string; type?: string; limit?: number; signal?: AbortSignal } = {},
      ) =>
        request<CloudflareManagedStateResponse>(
          "managedState",
          `/api/workbench/managed-state${queryString({
            namespace: input.namespace,
            type: input.type,
            limit: input.limit,
          })}`,
          { signal: input.signal },
        ),
    },
    devices: {
      list: (options: WorkbenchReadOptions = {}) =>
        request<CloudflareClientDevicesResponse>("devices", "/api/workbench/devices", options),
      register: (input: {
        installationId: string;
        platform: "ios" | "android";
        token: string;
        appVersion: string;
      }) =>
        request<CloudflareClientDevicesResponse>("devices", "/api/workbench/devices", {
          method: "POST",
          body: input,
          idempotencyKey: input.installationId,
        }),
      revoke: (deviceId: Id) =>
        request<CloudflareClientDevicesResponse>(
          "devices",
          `/api/workbench/devices/${encodeURIComponent(deviceId)}`,
          { method: "DELETE" },
        ),
    },
    billing: {
      get: (options: WorkbenchReadOptions = {}) =>
        request<BillingResponse<"GET /workbench/billing">>(
          "billing",
          "/api/workbench/billing",
          options,
        ),
      plans: (options: WorkbenchReadOptions = {}) =>
        request<BillingResponse<"GET /workbench/billing/plans">>(
          "billingPlans",
          "/api/workbench/billing/plans",
          options,
        ),
      assignPlan: (input: BillingRequest<"PUT /workbench/billing/plan">) =>
        request<BillingResponse<"PUT /workbench/billing/plan">>(
          "billing",
          "/api/workbench/billing/plan",
          {
            method: "PUT",
            body: input,
          },
        ),
      checkout: (input: BillingRequest<"POST /workbench/billing/checkout">) =>
        request<BillingResponse<"POST /workbench/billing/checkout">>(
          "billingLink",
          "/api/workbench/billing/checkout",
          { method: "POST", body: input },
        ),
      portal: (input: BillingRequest<"POST /workbench/billing/portal">) =>
        request<BillingResponse<"POST /workbench/billing/portal">>(
          "billingLink",
          "/api/workbench/billing/portal",
          { method: "POST", body: input },
        ),
      usage: (input: { from: string; to: string }, options: WorkbenchReadOptions = {}) =>
        request<BillingResponse<"GET /workbench/billing/usage">>(
          "billingUsage",
          `/api/workbench/billing/usage${queryString(input)}`,
          options,
        ),
      reportUsage: (input: BillingRequest<"POST /workbench/billing/usage/report">) =>
        request<BillingResponse<"POST /workbench/billing/usage/report">>(
          "billingUsageReport",
          "/api/workbench/billing/usage/report",
          { method: "POST", body: input },
        ),
    },
    memory: {
      list: (
        input: {
          kind?: MemoryKind;
          status?: "active" | "proposed" | "archived" | "all";
          scope?: "user" | "agent" | "workspace";
          targetType?: string;
          targetId?: string;
        } = {},
        options: WorkbenchReadOptions = {},
      ) =>
        request<{ ok: true; records: MemoryRecord[] }>(
          "memoryList",
          `/api/workbench/memory${queryString(input)}`,
          options,
        ),
      remember: (input: {
        kind: MemoryKind;
        key: string;
        title: string;
        content: Record<string, unknown>;
        scope?: "user" | "agent" | "workspace";
        target?: { type: string; id: string };
      }) =>
        request<{ ok: true; record: MemoryRecord }>(
          "memoryRecord",
          `/api/workbench/memory/${input.kind}/${encodeURIComponent(input.key)}`,
          {
            method: "PUT",
            body: {
              title: input.title,
              content: input.content,
              scope: input.scope,
              target: input.target,
            },
          },
        ),
      confirm: (id: Id) =>
        request<{ ok: true; record: MemoryRecord }>(
          "memoryRecord",
          `/api/workbench/memory/records/${encodeURIComponent(id)}/confirm`,
          { method: "POST" },
        ),
      forget: (id: Id) =>
        request<{ ok: true; record: MemoryRecord }>(
          "memoryRecord",
          `/api/workbench/memory/records/${encodeURIComponent(id)}`,
          { method: "DELETE" },
        ),
    },
    admin: {
      memory: {
        list: (
          input: {
            status?: "active" | "proposed" | "archived" | "all";
            kind?: MemoryKind;
            userId?: string;
            q?: string;
            limit?: number;
          } = {},
          options: WorkbenchReadOptions = {},
        ) =>
          request<{
            ok: true;
            records: AdminMemoryRecord[];
            members: { userId: string; label: string }[];
            policy: MemoryPolicyView;
            usage: { userId: string; activeRecords: number; totalBytes: number }[];
            limits: { recordBytes: number; activeRecords: number; totalBytes: number };
          }>("adminMemoryList", `/api/workbench/admin/memory${queryString(input)}`, options),
        bulkArchive: (filter: {
          status?: "active" | "proposed";
          kind?: MemoryKind;
          userId?: string;
          target?: { type: string; id: string };
          olderThanDays?: number;
          preview?: boolean;
        }) =>
          request<{ ok: true; archived: number; preview: boolean }>(
            "adminMemoryBulk",
            "/api/workbench/admin/memory/bulk-archive",
            { method: "POST", body: filter },
          ),
        update: (
          id: Id,
          patch: {
            title?: string;
            content?: Record<string, unknown>;
            kind?: MemoryKind;
            status?: "active" | "proposed" | "archived";
            target?: { type: string; id: string } | null;
            expiresAt?: string | null;
          },
        ) =>
          request<{ ok: true; record: AdminMemoryRecord }>(
            "adminMemoryRecord",
            `/api/workbench/admin/memory/${encodeURIComponent(id)}`,
            { method: "PATCH", body: patch },
          ),
      },
      events: {
        list: (
          input: {
            type?: string;
            userId?: string;
            q?: string;
            before?: string;
            limit?: number;
          } = {},
          options: WorkbenchReadOptions = {},
        ) =>
          request<{
            ok: true;
            events: AdminEvent[];
            types: string[];
            nextBefore: string | null;
          }>("adminEvents", `/api/workbench/admin/events${queryString(input)}`, options),
      },
    },
    notificationPreferences: {
      get: (options: WorkbenchReadOptions = {}) =>
        request<CloudflareNotificationPreferencesResponse>(
          "notificationPreferences",
          "/api/workbench/notification-preferences",
          options,
        ),
      update: (input: { approvalRequired: boolean; terminalOutcomes: boolean }) =>
        request<CloudflareNotificationPreferencesResponse>(
          "notificationPreferences",
          "/api/workbench/notification-preferences",
          { method: "PUT", body: input },
        ),
    },
  };
};

export type WorkbenchClient = ReturnType<typeof createWorkbenchClient>;

type BillingContracts = typeof publicBillingContracts;
type BillingResponse<K extends keyof BillingContracts> = z.infer<BillingContracts[K]["response"]>;
type BillingRequest<K extends keyof BillingContracts> = BillingContracts[K] extends {
  request: infer R;
}
  ? R extends z.ZodType
    ? z.infer<R>
    : never
  : never;
