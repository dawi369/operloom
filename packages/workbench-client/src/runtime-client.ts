import {
  findPublicContextContract,
  type ContextSnapshotResponse,
  type ContextSnapshotsQuery,
  type ContextSnapshotsResponse,
} from "./public-context-contracts.js";
import {
  findPublicUpgradeContract,
  type PackageUpgradeInput,
  type PackageUpgradeResponse,
  type PackageSnapshotsResponse,
} from "./public-upgrade-contracts.js";
import { WorkbenchClientError } from "./client.js";
import {
  findPublicActionContract,
  type ActionProposalsResponse,
  type ActionRequestResponse,
  type ActionReconciliationResponse,
} from "./public-action-contracts.js";
import {
  findPublicBudgetContract,
  type RuntimeBudgetSnapshot,
  type RuntimeBudgetUpdate,
  type RuntimeBudgetUpdated,
  type RuntimeUsageQuery,
  type RuntimeUsageResponse,
} from "./public-budget-contracts.js";
import { publicApiScopePath } from "./public-api.js";
import type { PublicMessage } from "./messages.js";
import { findPublicChatContract, type ChatCommandResponse } from "./public-chat-contracts.js";
import {
  findPublicStateContract,
  type RuntimeStateRecordQuery,
  type RuntimeStateEntryQuery,
  type RuntimeStateDeliveryQuery,
  type RuntimeStateRecordsResponse,
  type RuntimeStateEntriesResponse,
  type RuntimeStateDeliveriesResponse,
  type RuntimeStateMigrationQuery,
  type RuntimeStateMigrationResponse,
  type RuntimeStateMigrationsResponse,
} from "./public-state-contracts.js";

export type RuntimeClientOptions = {
  baseUrl: string;
  target: Readonly<{ workspaceId: string; agentId: string }>;
  getAccessToken: (input: {
    minValidityMs: number;
    forceRefresh: boolean;
  }) => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
};
export type RuntimeCommandOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
};
export type RuntimeEvent = { id?: string; type: string; data: Record<string, unknown> };

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const cleanup = () => signal.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });

export const createRuntimeClient = (options: RuntimeClientOptions) => {
  const origin = options.baseUrl.replace(/\/$/, "");
  const scope = publicApiScopePath({ ...options.target });
  const fetcher = options.fetch ?? globalThis.fetch;
  const fetchAuthorized = async (path: string, init: RequestInit, idempotencyKey?: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await options.getAccessToken({
        minValidityMs: 60_000,
        forceRefresh: attempt > 0,
      });
      if (!token)
        throw new WorkbenchClientError({
          status: 401,
          code: "authentication_required",
          message: "An access token is required",
        });
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
      const response = await fetcher(`${origin}${path}`, {
        ...init,
        headers,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      });
      if (response.status !== 401 || attempt > 0) return response;
      await response.body?.cancel();
    }
    throw new Error("Unreachable authentication retry");
  };
  const readJson = async <T>(response: Response): Promise<T> => {
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok)
      throw new WorkbenchClientError({
        status: response.status,
        message:
          typeof body?.error === "string" ? body.error : `Request failed (${response.status})`,
        code: typeof body?.code === "string" ? body.code : undefined,
        requestId: response.headers.get("x-request-id") ?? undefined,
      });
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new WorkbenchClientError({
        status: 0,
        code: "invalid_response",
        message: "Expected a JSON object",
      });
    return body as T;
  };
  const request = <T = Record<string, unknown>>(
    path: string,
    input: RuntimeCommandOptions = {},
  ): Promise<T> => {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("..") || path.includes("#"))
      throw new TypeError("A scoped operation path is required");
    const signal = input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
    return fetchAuthorized(
      `${scope}${path}`,
      {
        method: input.method ?? "GET",
        signal,
        headers: {
          accept: "application/json",
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
      },
      input.idempotencyKey,
    ).then(async (response) => {
      const body = await readJson<T>(response);
      const method = input.method ?? "GET";
      const operation = path.split("?")[0]!;
      const contract =
        findPublicChatContract(method, operation) ??
        findPublicStateContract(method, operation) ??
        findPublicUpgradeContract(method, operation) ??
        findPublicContextContract(method, operation) ??
        findPublicBudgetContract(method, operation) ??
        findPublicActionContract(method, operation);
      if (contract && !contract.response.safeParse(body).success)
        throw new WorkbenchClientError({
          status: 0,
          code: "invalid_response",
          message: "The response does not match the public operation contract",
          requestId: response.headers.get("x-request-id") ?? undefined,
        });
      return body;
    });
  };

  const events = (input: { after?: string; signal?: AbortSignal; mode?: "sse" | "poll" } = {}) => {
    const controller = new AbortController();
    const signal = input.signal
      ? AbortSignal.any([controller.signal, input.signal])
      : controller.signal;
    return {
      close: () => controller.abort(),
      async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeEvent> {
        let cursor = input.after;
        let backoff = 250;
        let polling = input.mode === "poll";
        while (!signal.aborted) {
          try {
            if (polling) {
              const result = await request<{
                events: Array<Record<string, unknown> & { id: string; type: string }>;
                resetRequired?: boolean;
              }>(`/events${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`, { signal });
              if (result.resetRequired) {
                cursor = undefined;
                yield { type: "reset", data: { reason: "cursor_expired" } };
              } else
                for (const event of cursor ? result.events : [...result.events].reverse()) {
                  cursor = event.id;
                  yield { id: event.id, type: event.type, data: event };
                }
              await wait(2000, signal);
              continue;
            }
            const response = await fetchAuthorized(`${scope}/events/stream`, {
              headers: {
                accept: "text/event-stream",
                ...(cursor ? { "last-event-id": cursor } : {}),
              },
              signal,
            });
            if ([405, 406, 501].includes(response.status)) {
              await response.body?.cancel();
              polling = true;
              continue;
            }
            if (!response.ok) {
              await readJson(response);
              continue;
            }
            if (
              !response.body ||
              !response.headers.get("content-type")?.includes("text/event-stream")
            ) {
              await response.body?.cancel();
              polling = true;
              continue;
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            try {
              while (!signal.aborted) {
                const chunk = await reader.read();
                buffer += decoder.decode(chunk.value, { stream: !chunk.done });
                if (buffer.length > 1_048_576) throw new Error("Event frame exceeds maximum size");
                const blocks = buffer.split(/\r?\n\r?\n/);
                buffer = blocks.pop() ?? "";
                for (const block of blocks) {
                  const lines = block.split(/\r?\n/);
                  const text = lines
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trimStart())
                    .join("\n");
                  if (!text) continue;
                  const data = JSON.parse(text) as Record<string, unknown>;
                  const type =
                    lines
                      .find((line) => line.startsWith("event:"))
                      ?.slice(6)
                      .trim() ?? "message";
                  const id = lines
                    .find((line) => line.startsWith("id:"))
                    ?.slice(3)
                    .trim();
                  if (type === "reset") cursor = undefined;
                  else if (id) cursor = id;
                  backoff = 250;
                  yield { id, type, data };
                }
                if (chunk.done) break;
              }
            } finally {
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          } catch (error) {
            if (signal.aborted) return;
            if (error instanceof WorkbenchClientError && !error.retryable) throw error;
          }
          try {
            await wait(backoff, signal);
          } catch {
            return;
          }
          backoff = Math.min(backoff * 2, 5000);
        }
      },
    };
  };
  const statePath = (resource: string, query: Record<string, unknown>) => {
    const parameters = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) parameters.set(key, String(value));
    return `/workbench/state/${resource}?${parameters}`;
  };
  return {
    request,
    events,
    budgets: {
      usage: (input: RuntimeUsageQuery) =>
        request<RuntimeUsageResponse>(
          `/workbench/usage?${new URLSearchParams(
            Object.entries(input)
              .filter(([, value]) => value !== undefined)
              .map(([key, value]) => [key, String(value)]),
          )}`,
        ),
      get: () => request<RuntimeBudgetSnapshot>("/workbench/budgets"),
      update: (input: RuntimeBudgetUpdate) =>
        request<RuntimeBudgetUpdated>("/workbench/budgets", {
          method: "PUT",
          body: input,
          idempotencyKey: input.idempotencyKey,
        }),
    },
    context: {
      list: (input: ContextSnapshotsQuery) =>
        request<ContextSnapshotsResponse>(
          `/workbench/context-snapshots?${new URLSearchParams(
            Object.entries(input)
              .filter(([, value]) => value !== undefined)
              .map(([key, value]) => [key, String(value)]),
          )}`,
        ),
      snapshot: (id: string) =>
        request<ContextSnapshotResponse>(`/workbench/context-snapshots/${encodeURIComponent(id)}`),
    },
    packages: {
      upgrade: (input: PackageUpgradeInput) =>
        request<PackageUpgradeResponse>("/workbench/package-upgrades", {
          method: "POST",
          body: input,
          idempotencyKey: input.idempotencyKey,
        }),
      snapshots: (beforeRevision?: number) =>
        request<PackageSnapshotsResponse>(
          `/workbench/package-snapshots${beforeRevision === undefined ? "" : `?beforeRevision=${beforeRevision}`}`,
        ),
    },
    state: {
      repairMigration: (
        id: string,
        input: {
          target: "simulation" | "external";
          expectedRevision: number;
          replacementId: string;
          idempotencyKey: string;
        },
      ) =>
        request<RuntimeStateMigrationResponse>(
          `/workbench/state/migrations/${encodeURIComponent(id)}/repair`,
          { method: "POST", body: input, idempotencyKey: input.idempotencyKey },
        ),
      migrations: (query: RuntimeStateMigrationQuery, signal?: AbortSignal) =>
        request<RuntimeStateMigrationsResponse>(statePath("migrations", query), { signal }),
      startMigration: (id: string, target: "simulation" | "external") =>
        request<RuntimeStateMigrationResponse>(
          `/workbench/state/migrations/${encodeURIComponent(id)}`,
          { method: "POST", body: { target } },
        ),
      advanceMigration: (
        id: string,
        input: { target: "simulation" | "external"; expectedRevision: number },
      ) =>
        request<RuntimeStateMigrationResponse>(
          `/workbench/state/migrations/${encodeURIComponent(id)}/advance`,
          { method: "POST", body: input },
        ),
      records: (query: RuntimeStateRecordQuery, signal?: AbortSignal) =>
        request<RuntimeStateRecordsResponse>(statePath("records", query), { signal }),
      entries: (query: RuntimeStateEntryQuery, signal?: AbortSignal) =>
        request<RuntimeStateEntriesResponse>(statePath("entries", query), { signal }),
      deliveries: (query: RuntimeStateDeliveryQuery, signal?: AbortSignal) =>
        request<RuntimeStateDeliveriesResponse>(statePath("deliveries", query), { signal }),
      retryDelivery: (
        id: string,
        input: { target: "simulation" | "external"; expectedAttempts: number },
      ) =>
        request<{ ok: true; id: string; status: "pending" }>(
          `/workbench/state/deliveries/${encodeURIComponent(id)}/retry`,
          { method: "POST", body: input },
        ),
    },
    account: () =>
      fetchAuthorized("/v1/account", { signal: AbortSignal.timeout(30_000) }).then((response) =>
        readJson(response),
      ),
    threads: {
      create: () =>
        request<{ ok: true; threadId: string; sessionId: string; agentId: string }>(
          "/chat/threads",
          { method: "POST" },
        ),
      messages: (threadId: string, signal?: AbortSignal) =>
        request<{
          ok: true;
          messages: PublicMessage[];
          run?: { id: string; status: string } | null;
        }>(`/chat/threads/${encodeURIComponent(threadId)}/messages`, { signal }),
      submit: (threadId: string, text: string, idempotencyKey: string) =>
        request<{ ok: true; messageId: string; status: "accepted"; commandId?: string }>(
          `/chat/threads/${encodeURIComponent(threadId)}/turns`,
          { method: "POST", body: { text }, idempotencyKey },
        ),
      cancel: (threadId: string) =>
        request(`/chat/threads/${encodeURIComponent(threadId)}/cancel`, { method: "POST" }),
      command: (commandId: string) =>
        request<ChatCommandResponse>(`/chat/commands/${encodeURIComponent(commandId)}`),
    },
    admin: {
      actions: (query: { limit?: number } = {}) =>
        request<ActionProposalsResponse>(
          `/workbench/actions${query.limit === undefined ? "" : `?limit=${encodeURIComponent(query.limit)}`}`,
        ),
      requestAction: (proposalId: string) =>
        request<ActionRequestResponse>(
          `/workbench/actions/${encodeURIComponent(proposalId)}/execute`,
          { method: "POST" },
        ),
      reconcileAction: (proposalId: string) =>
        request<ActionReconciliationResponse>(
          `/workbench/actions/${encodeURIComponent(proposalId)}/reconcile`,
          { method: "POST" },
        ),
      summary: () => request("/admin/workspace-summary"),
      export: () => request("/workbench/data-exports", { method: "POST" }),
      retention: () => request("/workbench/retention-policy"),
      triggers: () => request("/triggers"),
      killSwitches: () => request("/workbench/kill-switches"),
    },
  };
};
