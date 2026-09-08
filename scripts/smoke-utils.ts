/**
 * Shared utilities for Cloudflare control-plane smoke tests.
 *
 * Every smoke script that talks to the control-plane Worker duplicates the same
 * boilerplate: TenantIdentity type, headersFor(), readJson(), sleep(), the
 * main/catch wrapper, etc.  This module extracts those into a single place.
 */

import { signFacadeRequest } from "../lib/workbench/control-plane-signing";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/**
 * Superset identity covering both account-based (authz, workspaces, agents …)
 * and direct-scope (chat-boundary, session-boundary, events …) smoke patterns.
 *
 * Each script populates only the fields its test needs.  `headersFor` maps
 * whatever is present to the matching `x-assistant-mk1-*` request headers.
 */
export type TenantIdentity = {
  userId: string;
  accountId?: string;
  accountSource?: string;
  workspaceId?: string;
  agentId?: string;
  email?: string;
  name?: string;
  role?: string;
  roles?: string[];
  permissions?: string[];
  membershipStatus?: string;
  authMode?: string;
  workspaceSource?: string;
};

export type ThreadResponse = {
  thread_id?: string;
  error?: string;
};

/* ------------------------------------------------------------------ */
/*  Standalone helpers                                                 */
/* ------------------------------------------------------------------ */

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const defaultWorkspaceId = (accountId: string) => `workspace:${accountId}:default`;

export function runSmoke(label: string, fn: () => Promise<void>) {
  fn()
    .then(() => console.log(`${label} passed`))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}

/* ------------------------------------------------------------------ */
/*  Smoke context factory                                              */
/* ------------------------------------------------------------------ */

export type SmokeContext = ReturnType<typeof createSmokeContext>;

export function createSmokeContext(options?: {
  baseUrlEnv?: string;
  baseUrlDefault?: string;
  tokenEnv?: string;
  tokenDefault?: string;
  pollTimeoutDefault?: number;
  pollIntervalDefault?: number;
}) {
  const baseUrl = (
    process.env[options?.baseUrlEnv ?? "CLOUDFLARE_CONTROL_PLANE_URL"] ??
    options?.baseUrlDefault ??
    "http://localhost:8787"
  ).replace(/\/$/, "");

  const token =
    process.env[options?.tokenEnv ?? "CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN"] ??
    options?.tokenDefault ??
    "local-dev-token";
  const signingSecret = process.env.CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET?.trim();

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const pollTimeoutMs = Number(
    process.env.SMOKE_TIMEOUT_MS ?? options?.pollTimeoutDefault ?? 30_000,
  );
  const pollIntervalMs = Number(
    process.env.SMOKE_POLL_INTERVAL_MS ?? options?.pollIntervalDefault ?? 400,
  );

  /* ---- header builder ---- */

  const headersFor = (identity: TenantIdentity): Record<string, string> => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-assistant-mk1-user-id": identity.userId,
    };

    if (identity.accountId) headers["x-assistant-mk1-account-id"] = identity.accountId;
    if (identity.accountSource) headers["x-assistant-mk1-account-source"] = identity.accountSource;
    if (identity.workspaceId) headers["x-assistant-mk1-workspace-id"] = identity.workspaceId;
    if (identity.agentId) headers["x-assistant-mk1-agent-id"] = identity.agentId;
    if (identity.email) headers["x-assistant-mk1-user-email"] = identity.email;
    if (identity.name) headers["x-assistant-mk1-user-name"] = identity.name;
    if (identity.role) headers["x-assistant-mk1-membership-role"] = identity.role;
    if (identity.roles)
      headers["x-assistant-mk1-membership-roles"] = JSON.stringify(identity.roles);
    if (identity.permissions) {
      headers["x-assistant-mk1-membership-permissions"] = JSON.stringify(identity.permissions);
    }
    if (identity.membershipStatus) {
      headers["x-assistant-mk1-membership-status"] = identity.membershipStatus;
    }
    if (identity.authMode) headers["x-assistant-mk1-auth-mode"] = identity.authMode;
    if (identity.workspaceSource) {
      headers["x-assistant-mk1-workspace-source"] = identity.workspaceSource;
    }

    return headers;
  };

  const signedHeadersFor = async (
    identity: TenantIdentity,
    path: string,
    init?: RequestInit,
  ): Promise<Record<string, string>> => {
    const headers = {
      ...headersFor(identity),
      ...(init?.headers as Record<string, string> | undefined),
    };
    if (!signingSecret) return headers;

    Object.assign(
      headers,
      await signFacadeRequest({
        secret: signingSecret,
        method: init?.method ?? "GET",
        pathWithQuery: path,
        body: typeof init?.body === "string" ? init.body : "",
        headers,
      }),
    );
    return headers;
  };

  /* ---- request helpers ---- */

  const readJson = async <T>(
    path: string,
    identity: TenantIdentity,
    init?: RequestInit,
  ): Promise<T> => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: await signedHeadersFor(identity, path, init),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${init?.method ?? "GET"} ${path} failed with ${response.status}: ${body}`);
    }
    return (await response.json()) as T;
  };

  const fetchRaw = async (
    path: string,
    identity: TenantIdentity,
    init?: RequestInit,
  ): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: await signedHeadersFor(identity, path, init),
    });

  const assertStatus = async (
    path: string,
    identity: TenantIdentity,
    expectedStatus: number,
    init?: RequestInit,
  ) => {
    const response = await fetchRaw(path, identity, init);
    if (response.status !== expectedStatus) {
      const body = await response.text();
      throw new Error(`${path} expected ${expectedStatus}, got ${response.status}: ${body}`);
    }
  };

  /* ---- LangGraph helpers ---- */

  const createThread = async (identity: TenantIdentity) => {
    const thread = await readJson<ThreadResponse>("/langgraph/threads", identity, {
      method: "POST",
      body: "{}",
    });
    if (!thread.thread_id) throw new Error(thread.error ?? "thread_id missing");
    return thread.thread_id;
  };

  const streamBody = (input: { content: string; executionMode?: "ask" | "dry_run" | "execute" }) =>
    JSON.stringify({
      assistant_id: "agent",
      execution_mode: input.executionMode,
      input: {
        messages: [{ role: "user", content: input.content }],
      },
      stream_mode: ["messages"],
    });

  const startStream = async (identity: TenantIdentity, threadId: string, body: string) => {
    const path = `/langgraph/threads/${encodeURIComponent(threadId)}/runs/stream`;
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: await signedHeadersFor(identity, path, { method: "POST", body }),
      body,
    });
  };

  const startAcceptedStreamOnNewThread = async (
    identity: TenantIdentity,
    body: string,
    label: string,
  ) => {
    let lastError = "";

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const threadId = await createThread(identity);
      const response = await startStream(identity, threadId, body);
      if (response.ok) return { threadId, response };

      const responseBody = await response.text();
      lastError = `${response.status}: ${responseBody}`;
      if (response.status !== 409 || !responseBody.includes("already_running")) {
        throw new Error(`${label} failed with ${lastError}`);
      }

      await sleep(1_000);
    }

    throw new Error(`${label} failed after retries with ${lastError}`);
  };

  return {
    baseUrl,
    token,
    suffix,
    pollTimeoutMs,
    pollIntervalMs,
    headersFor,
    signedHeadersFor,
    readJson,
    fetchRaw,
    assertStatus,
    createThread,
    streamBody,
    startStream,
    startAcceptedStreamOnNewThread,
  };
}
