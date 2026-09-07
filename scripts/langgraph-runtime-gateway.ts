import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import * as Sentry from "@sentry/node";

import {
  canonicalFacadeRequest,
  facadeContentSha256Header,
  facadeSignatureHeader,
  facadeSignatureNonceHeader,
  facadeSignatureTimestampHeader,
  hmacSha256Base64Url,
  signFacadeRequest,
  sha256Base64Url,
} from "../lib/workbench/control-plane-signing";
import {
  assertSchemaValue,
  defaultActionPort,
  defaultConnectionPort,
  type AgentExecutionContext,
  type AgentPackConnectionDescriptor,
  type ConnectionPort,
  type RuntimeResult,
  type RuntimeToolBinding,
} from "@operloom/agent-sdk/control-plane";
import { agentManifestRegistry } from "../generated/agent-runtime/manifests";
import { agentRunnerRegistry } from "../generated/agent-runtime/runner";
import { compiledWorkbenchVersion } from "../generated/agent-runtime/platform";
import { resolvePlatformRunnerTool } from "../lib/agent-runtime/core-runner-provider";
import { scrubSentryBreadcrumb, scrubSentryEvent } from "../lib/observability/sentry-scrubber";

function parseSentrySampleRate(value: string | undefined): number {
  const parsed = Number(value ?? "0.02");
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.02;
}

const sentryDsn = process.env.SENTRY_DSN?.trim();
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? "production",
    release: process.env.SENTRY_RELEASE ?? process.env.WORKBENCH_RELEASE_SHA,
    tracesSampleRate: parseSentrySampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
    sendDefaultPii: false,
    beforeSend: scrubSentryEvent,
    beforeBreadcrumb: scrubSentryBreadcrumb,
    initialScope: {
      tags: {
        service: "operloom",
        "runtime.surface": "fly-langgraph",
        "runtime.target": "gateway",
      },
    },
  });
}

const port = Number(process.env.PORT ?? 3000);
const langGraphUpstreamUrl = (
  process.env.LANGGRAPH_UPSTREAM_URL ?? "http://127.0.0.1:2024"
).replace(/\/$/, "");
const runnerInvocationPath = "/workbench/tool-runners/invocations";
const signatureWindowMs = 5 * 60 * 1000;
const runnerNonces = new Map<string, number>();
const e2eMode = process.env.WORKBENCH_E2E_MODE === "true";
const syntheticConformanceMode = e2eMode || process.env.WORKBENCH_CONFORMANCE_MODE === "true";
const requestedE2eDelayMs = Number(process.env.WORKBENCH_E2E_RUNNER_DELAY_MS ?? "0");
if (requestedE2eDelayMs > 0 && !e2eMode) {
  throw new Error("WORKBENCH_E2E_RUNNER_DELAY_MS requires WORKBENCH_E2E_MODE=true");
}
const e2eRunnerDelayMs = e2eMode
  ? Math.min(5_000, Math.max(0, Math.trunc(requestedE2eDelayMs || 0)))
  : 0;
const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const e2eOAuthCodes = new Map<string, string>();
const e2eSyntheticActions = new Map<string, { externalReference: string }>();

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
};

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const parseJsonBuffer = <T>(body: Buffer): T | null => {
  try {
    return JSON.parse(body.toString("utf8")) as T;
  } catch {
    return null;
  }
};

const constantTimeEqual = (a: string, b: string) => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

const bearerToken = (value: string) => `Bearer ${value}`;

const firstHeader = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

const headerValue = (request: IncomingMessage, name: string) =>
  firstHeader(request.headers[name.toLowerCase()])?.trim() ?? "";

const assistantHeaders = (request: IncomingMessage) => {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    const item = firstHeader(value);
    if (item && key.toLowerCase().startsWith("x-assistant-mk1-")) {
      headers[key.toLowerCase()] = item;
    }
  }
  return headers;
};

const isAuthorized = (request: IncomingMessage, token: string) => {
  const apiKey = Array.isArray(request.headers["x-api-key"])
    ? request.headers["x-api-key"][0]
    : request.headers["x-api-key"];
  const authorization = request.headers.authorization;
  if (apiKey && constantTimeEqual(apiKey, token)) return true;
  if (authorization && constantTimeEqual(authorization, bearerToken(token))) return true;
  return false;
};

const requireProxyAuth = (request: IncomingMessage, response: ServerResponse) => {
  const token = process.env.LANGGRAPH_PROXY_TOKEN;
  if (!token) {
    json(response, 500, { ok: false, error: "LANGGRAPH_PROXY_TOKEN is not configured" });
    return false;
  }

  if (!isAuthorized(request, token)) {
    json(response, 401, { ok: false, error: "unauthorized" });
    return false;
  }

  return true;
};

const authError = (response: ServerResponse, code: string, message: string, status = 401) => {
  json(response, status, {
    ok: false,
    error: message,
    details: { code, message, retryable: false, redacted: true },
  });
};

const verifyRunnerSignature = async (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  body: Buffer,
) => {
  const secret = process.env.WORKBENCH_RUNNER_SIGNING_SECRET?.trim();
  if (!secret) {
    authError(
      response,
      "runner_signature_not_configured",
      "Runner signing is not configured.",
      500,
    );
    return false;
  }

  const signature = headerValue(request, facadeSignatureHeader);
  const timestamp = headerValue(request, facadeSignatureTimestampHeader);
  const nonce = headerValue(request, facadeSignatureNonceHeader);
  const declaredBodyHash = headerValue(request, facadeContentSha256Header);
  if (!signature || !timestamp || !nonce || !declaredBodyHash) {
    authError(response, "signature_required", "Signed runner request is required.");
    return false;
  }

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > signatureWindowMs) {
    authError(response, "signature_stale", "Signed runner request is stale.");
    return false;
  }

  const bodyText = body.toString("utf8");
  const actualBodyHash = await sha256Base64Url(bodyText);
  if (!constantTimeEqual(actualBodyHash, declaredBodyHash)) {
    authError(response, "body_hash_mismatch", "Signed runner body hash is invalid.");
    return false;
  }

  const now = Date.now();
  for (const [storedNonce, expiresAt] of runnerNonces) {
    if (expiresAt <= now) runnerNonces.delete(storedNonce);
  }
  if (runnerNonces.has(nonce)) {
    authError(response, "signature_replay", "Signed runner nonce was already used.");
    return false;
  }

  const canonical = canonicalFacadeRequest({
    method: request.method ?? "GET",
    pathWithQuery: `${url.pathname}${url.search}`,
    timestamp,
    nonce,
    bodyHash: declaredBodyHash,
    headers: assistantHeaders(request),
  });
  const expectedSignature = await hmacSha256Base64Url(secret, canonical);
  if (!constantTimeEqual(expectedSignature, signature)) {
    authError(response, "signature_invalid", "Signed runner request is invalid.");
    return false;
  }

  runnerNonces.set(nonce, now + signatureWindowMs);
  return true;
};

const isLangGraphReady = async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 750);

  try {
    const response = await fetch(`${langGraphUpstreamUrl}/ok`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
};

type ToolRunnerInvocation = {
  toolName?: string;
  input?: unknown;
  scope?: {
    userId?: unknown;
    workspaceId?: unknown;
  };
  agentId?: unknown;
  runId?: unknown;
  workflowIntentId?: unknown;
  toolCallId?: unknown;
  packVersion?: unknown;
  runtimeVersion?: unknown;
  bindingVersion?: unknown;
  execution?: {
    mode?: unknown;
    policy?: unknown;
  };
  policyDecisionId?: unknown;
  source?: unknown;
  traceId?: unknown;
  callback?: {
    url?: unknown;
    protocolVersion?: unknown;
    traceId?: unknown;
  };
  connectionCapability?: {
    url?: unknown;
    token?: unknown;
    connectionId?: unknown;
    allowedUrl?: unknown;
    allowedMethod?: unknown;
    expiresAt?: unknown;
  };
  runner?: {
    transport?: unknown;
    adapterVersion?: unknown;
    source?: unknown;
    sandbox?: {
      network?: {
        egress?: unknown;
        allowedSchemes?: unknown;
        allowedHosts?: unknown;
        deniedHosts?: unknown;
        privateNetwork?: unknown;
      };
    };
  };
};

type WorkflowCallbackPayload = {
  event: "run.started" | "run.progress" | "artifact.created" | "run.completed" | "run.failed";
  runId: string;
  workflowIntentId: string;
  summary?: string;
  sequence?: number;
  traceId?: string;
  toolCall?: {
    id: string;
    toolId: string;
    status?: string;
    outputSummary?: string;
    artifactRefs?: unknown[];
    data?: Record<string, unknown>;
  };
  artifact?: {
    id: string;
    kind: string;
    uri: string;
    title?: string;
    mimeType?: string;
    sizeBytes?: number;
    data?: Record<string, unknown>;
  };
  outputSummary?: string;
  error?: string;
  output?: Record<string, unknown>;
};

type RunnerToolResult = RuntimeResult;

const callbackTraceId = (invocation: ToolRunnerInvocation) => {
  if (typeof invocation.callback?.traceId === "string" && invocation.callback.traceId.trim()) {
    return invocation.callback.traceId.trim();
  }
  if (typeof invocation.traceId === "string" && invocation.traceId.trim()) {
    return invocation.traceId.trim();
  }
  return undefined;
};

const callbackFailure = (
  toolName: string,
  message: string,
  input?: {
    code?: string;
    retryable?: boolean;
  },
): RunnerToolResult => ({
  ok: false,
  error: {
    code: input?.code ?? "runner_callback_failed",
    message,
    retryable: input?.retryable ?? true,
    redacted: true,
  },
  summary: message,
});

const logCallbackFailure = (
  invocation: ToolRunnerInvocation,
  payload: WorkflowCallbackPayload,
  input: { status: number | string; code: string; message: string },
) => {
  console.warn("runner.callback_failed", {
    component: "langgraph-runtime-gateway",
    event: "runner.callback.failed",
    toolName: typeof invocation.toolName === "string" ? invocation.toolName : undefined,
    runId: payload.runId,
    workflowIntentId: payload.workflowIntentId,
    callbackEvent: payload.event,
    status: input.status,
    code: input.code,
    message: input.message,
  });
};

const postWorkflowCallback = async (
  invocation: ToolRunnerInvocation,
  payload: WorkflowCallbackPayload,
): Promise<{ ok: true } | { ok: false; result: RunnerToolResult; status: number }> => {
  if (!invocation.callback) return { ok: true };
  const toolName = typeof invocation.toolName === "string" ? invocation.toolName : "";
  if (
    invocation.callback.protocolVersion !== "workflow-callback-v0" ||
    typeof invocation.callback.url !== "string" ||
    !invocation.callback.url.trim()
  ) {
    return {
      ok: false,
      status: 400,
      result: callbackFailure(toolName, "Runner callback context is invalid."),
    };
  }

  const secret = process.env.WORKBENCH_CALLBACK_SIGNING_SECRET?.trim();
  if (!secret) {
    const message = "Workbench callback signing is not configured for the runner.";
    logCallbackFailure(invocation, payload, {
      status: 500,
      code: "runner_callback_signing_not_configured",
      message,
    });
    return {
      ok: false,
      status: 500,
      result: callbackFailure(toolName, message, {
        code: "runner_callback_signing_not_configured",
        retryable: false,
      }),
    };
  }

  let callbackUrl: URL;
  try {
    callbackUrl = new URL(invocation.callback.url);
  } catch {
    return {
      ok: false,
      status: 400,
      result: callbackFailure(toolName, "Runner callback URL is invalid."),
    };
  }
  const configuredCallbackOrigin = process.env.WORKBENCH_CALLBACK_ORIGIN?.trim();
  if (!configuredCallbackOrigin) {
    return {
      ok: false,
      status: 500,
      result: callbackFailure(toolName, "Runner callback origin is not configured.", {
        code: "runner_callback_origin_not_configured",
        retryable: false,
      }),
    };
  }
  let allowedCallbackOrigin: string;
  try {
    allowedCallbackOrigin = new URL(configuredCallbackOrigin).origin;
  } catch {
    return {
      ok: false,
      status: 500,
      result: callbackFailure(toolName, "Runner callback origin is invalid.", {
        code: "runner_callback_origin_invalid",
        retryable: false,
      }),
    };
  }
  if (callbackUrl.origin !== allowedCallbackOrigin) {
    return {
      ok: false,
      status: 400,
      result: callbackFailure(toolName, "Runner callback origin is not allowed.", {
        code: "runner_callback_origin_not_allowed",
        retryable: false,
      }),
    };
  }

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-assistant-mk1-run-id": payload.runId,
    "x-assistant-mk1-workflow-intent-id": payload.workflowIntentId,
    "x-assistant-mk1-tool-name": toolName,
  };
  Object.assign(
    headers,
    await signFacadeRequest({
      secret,
      method: "POST",
      pathWithQuery: `${callbackUrl.pathname}${callbackUrl.search}`,
      body,
      headers,
    }),
  );

  let response: Response;
  try {
    response = await fetch(callbackUrl, {
      method: "POST",
      headers,
      body,
    });
  } catch {
    logCallbackFailure(invocation, payload, {
      status: "network_error",
      code: "callback_delivery_failed",
      message: `Callback delivery failed for ${payload.event}.`,
    });
    return {
      ok: false,
      status: 502,
      result: callbackFailure(toolName, `Callback delivery failed for ${payload.event}.`),
    };
  }

  if (!response.ok) {
    logCallbackFailure(invocation, payload, {
      status: response.status,
      code: "callback_rejected",
      message: `Callback ${payload.event} was rejected with ${response.status}.`,
    });
    return {
      ok: false,
      status: response.status >= 500 ? 502 : 500,
      result: callbackFailure(
        toolName,
        `Callback ${payload.event} was rejected with ${response.status}.`,
      ),
    };
  }

  return { ok: true };
};

const emitRunnerCallback = async (
  invocation: ToolRunnerInvocation,
  payload: Omit<WorkflowCallbackPayload, "runId" | "workflowIntentId" | "traceId">,
) => {
  const runId = typeof invocation.runId === "string" ? invocation.runId : "";
  const workflowIntentId =
    typeof invocation.workflowIntentId === "string" ? invocation.workflowIntentId : "";
  return postWorkflowCallback(invocation, {
    ...payload,
    runId,
    workflowIntentId,
    traceId: callbackTraceId(invocation),
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const runnerConnectionPort = (
  connections: readonly AgentPackConnectionDescriptor[],
  rawCapability: ToolRunnerInvocation["connectionCapability"],
): ConnectionPort => ({
  async resolve(connectionId, toolId) {
    const descriptor = connections.find(
      (candidate) => candidate.id === connectionId && candidate.toolIds.includes(toolId),
    );
    if (!descriptor || descriptor.credentialClass === "none") {
      return defaultConnectionPort(connections).resolve(connectionId, toolId);
    }
    if (
      rawCapability?.connectionId !== connectionId ||
      typeof rawCapability.url !== "string" ||
      typeof rawCapability.token !== "string" ||
      typeof rawCapability.allowedUrl !== "string" ||
      typeof rawCapability.allowedMethod !== "string" ||
      typeof rawCapability.expiresAt !== "string" ||
      Date.parse(rawCapability.expiresAt) <= Date.now()
    ) {
      return {
        id: connectionId,
        status: "authorization_required",
        reason: `${toolId} has no valid broker capability.`,
      };
    }
    const capability = {
      url: rawCapability.url,
      token: rawCapability.token,
      allowedUrl: rawCapability.allowedUrl,
      allowedMethod: rawCapability.allowedMethod,
    };
    return {
      id: connectionId,
      status: "authorized",
      reason: `${connectionId} is available through a single-use broker capability.`,
      request: async (input) => {
        const method = (input.method ?? "GET").toUpperCase();
        const requestedUrl =
          input.url === "broker://configured" ? capability.allowedUrl : input.url;
        if (requestedUrl !== capability.allowedUrl || method !== capability.allowedMethod) {
          throw Object.assign(new Error("Broker capability request is out of scope."), {
            code: "capability_scope_violation",
          });
        }
        const response = await fetch(capability.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${capability.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ ...input, url: requestedUrl }),
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        const parsed = (await response.json().catch(() => null)) as unknown;
        if (!response.ok || !isRecord(parsed) || !isRecord(parsed.response)) {
          throw Object.assign(new Error("Brokered provider request failed."), {
            code:
              isRecord(parsed) && typeof parsed.code === "string"
                ? parsed.code
                : "broker_request_failed",
          });
        }
        return {
          status: Number(parsed.response.status),
          headers: isRecord(parsed.response.headers)
            ? (parsed.response.headers as Record<string, string>)
            : {},
          body: typeof parsed.response.body === "string" ? parsed.response.body : "",
        };
      },
    };
  },
});

const handleToolRunnerInvocation = async (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) => {
  if (request.method !== "POST") {
    json(response, 405, { ok: false, error: "method not allowed" });
    return;
  }

  const body = await readBody(request);
  if (!(await verifyRunnerSignature(request, response, url, body))) return;

  const parsed = parseJsonBuffer<ToolRunnerInvocation>(body);
  if (!parsed || typeof parsed !== "object") {
    json(response, 400, { ok: false, error: "request body must be JSON" });
    return;
  }
  const genericRunnerEntry = Object.values(agentRunnerRegistry).find((entry) =>
    entry.module.tools.some((tool) => tool.id === parsed.toolName),
  );
  const genericRunnerTool = genericRunnerEntry?.module.tools.find(
    (tool) => tool.id === parsed.toolName,
  ) as RuntimeToolBinding | undefined;
  const platformRunnerTool = resolvePlatformRunnerTool(parsed.toolName ?? "") as
    | RuntimeToolBinding
    | undefined;
  const runnerTool = genericRunnerTool ?? platformRunnerTool;
  if (!runnerTool) {
    json(response, 400, {
      ok: false,
      error: "unsupported tool",
      details: {
        code: "unsupported_tool",
        message: "The requested tool is not registered by the compiled runner modules.",
        retryable: false,
        redacted: true,
      },
    });
    return;
  }

  {
    const network = isRecord(parsed.runner?.sandbox) ? parsed.runner.sandbox.network : null;
    if (!isRecord(network)) {
      json(response, 403, {
        ok: false,
        error: {
          code: "sandbox_required",
          message: "A signed runner network policy is required.",
          retryable: false,
          redacted: true,
        },
      });
      return;
    }
    const manifestEntry = genericRunnerEntry
      ? agentManifestRegistry[
          genericRunnerEntry.module.packId as keyof typeof agentManifestRegistry
        ]
      : null;
    const packId = genericRunnerEntry?.module.packId ?? "platform";
    const packVersion = manifestEntry?.module.version ?? "1.0.0";
    const runtimeVersion = genericRunnerEntry?.module.runtimeVersion ?? "1.0.0";
    if (
      parsed.runner?.adapterVersion !== runnerTool.adapterVersion ||
      parsed.packVersion !== packVersion ||
      parsed.runtimeVersion !== runtimeVersion ||
      parsed.bindingVersion !== 1 ||
      !["ask", "dry_run", "execute"].includes(String(parsed.execution?.mode)) ||
      !runnerTool.executionModes.includes(
        parsed.execution?.mode as "ask" | "dry_run" | "execute",
      ) ||
      !isRecord(network) ||
      network.privateNetwork !== "deny" ||
      !["none", "public_web"].includes(String(network.egress)) ||
      ![network.allowedSchemes, network.allowedHosts, network.deniedHosts].every(
        (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string"),
      )
    ) {
      json(response, 403, {
        ok: false,
        error: {
          code: "runner_contract_mismatch",
          message: "The signed invocation does not match the compiled runner contract.",
          retryable: false,
          redacted: true,
        },
      });
      return;
    }
    if (!runnerTool.execute || !isRecord(parsed.input)) {
      json(response, 409, {
        ok: false,
        error: {
          code: "runner_binding_unavailable",
          message: "The compiled runner binding is not executable.",
          retryable: false,
          redacted: true,
        },
      });
      return;
    }
    const runId = typeof parsed.runId === "string" ? parsed.runId : "unknown-run";
    const workflowIntentId =
      typeof parsed.workflowIntentId === "string"
        ? parsed.workflowIntentId
        : "unknown-workflow-intent";
    const toolCallId =
      typeof parsed.toolCallId === "string" && parsed.toolCallId
        ? parsed.toolCallId
        : `${runId}-tool-${String(parsed.toolName).replace(/[^a-z0-9_-]/gi, "-")}`;
    const context: AgentExecutionContext = {
      scope: {
        userId: typeof parsed.scope?.userId === "string" ? parsed.scope.userId : "unknown-user",
        workspaceId:
          typeof parsed.scope?.workspaceId === "string"
            ? parsed.scope.workspaceId
            : "unknown-workspace",
        agentId: typeof parsed.agentId === "string" ? parsed.agentId : "unknown-agent",
      },
      pack: {
        id: packId,
        version: packVersion,
        runtimeVersion,
      },
      run: {
        id: runId,
        workflowIntentId,
        executionMode: parsed.execution!.mode as "ask" | "dry_run" | "execute",
        source: "user",
      },
      networkPolicy: {
        egress: network.egress as "none" | "public_web",
        allowedSchemes: network.allowedSchemes as string[],
        allowedHosts: network.allowedHosts as string[],
        deniedHosts: network.deniedHosts as string[],
      },
      signal: new AbortController().signal,
      connections: runnerConnectionPort(
        manifestEntry?.module.connections ?? [],
        parsed.connectionCapability,
      ),
      actions: defaultActionPort,
      tools: {
        async invoke() {
          throw Object.assign(new Error("Nested runner tool invocation is unavailable."), {
            code: "nested_tool_invocation_disabled",
          });
        },
      },
      managedState: {
        async upsert() {
          throw Object.assign(new Error("Runner modules cannot write managed state."), {
            code: "runner_state_write_disabled",
          });
        },
      },
      events: { async append() {} },
    };
    const startedAt = Date.now();
    try {
      const progressCallback = await emitRunnerCallback(parsed, {
        event: "run.progress",
        sequence: 1,
        summary: `${parsed.toolName} runner started.`,
        toolCall: {
          id: toolCallId,
          toolId: String(parsed.toolName),
          status: "running",
          data: {
            packVersion: typeof parsed.packVersion === "string" ? parsed.packVersion : undefined,
            runtimeVersion:
              typeof parsed.runtimeVersion === "string" ? parsed.runtimeVersion : undefined,
            bindingVersion:
              typeof parsed.bindingVersion === "number" ? parsed.bindingVersion : undefined,
            adapterVersion: runnerTool.adapterVersion,
            transport: "fly",
          },
        },
      });
      if (!progressCallback.ok) {
        json(response, progressCallback.status === 500 ? 409 : progressCallback.status, {
          ok: false,
          error: {
            code: "publication_revoked",
            message: "Runner publication authority was revoked.",
            retryable: false,
            redacted: true,
          },
          runner: parsed.runner,
        });
        return;
      }
      assertSchemaValue(runnerTool.inputSchema, parsed.input, `${parsed.toolName} input`);
      if (e2eRunnerDelayMs > 0) await delay(e2eRunnerDelayMs);
      const result = await runnerTool.execute(parsed.input, context);
      if (result.ok) {
        assertSchemaValue(runnerTool.outputSchema, result.output, `${parsed.toolName} output`);
      }
      if (result.ok) {
        for (const [index, artifact] of (result.artifacts ?? []).entries()) {
          const artifactId = `${toolCallId}-artifact-${artifact.kind.replace(/[^a-z0-9_-]/gi, "-")}${index ? `-${index + 1}` : ""}`;
          const artifactCallback = await emitRunnerCallback(parsed, {
            event: "artifact.created",
            sequence: index + 2,
            summary: `Created ${artifact.title}.`,
            artifact: {
              id: artifactId,
              kind: artifact.kind,
              uri: `d1://control-plane/${runId}/${artifact.kind}.json`,
              title: artifact.title,
              mimeType: artifact.mimeType,
              sizeBytes: JSON.stringify(artifact.data).length,
              data:
                JSON.stringify(artifact.data).length <= 8 * 1024
                  ? artifact.data
                  : { summary: result.summary, truncated: true },
            },
            toolCall: {
              id: toolCallId,
              toolId: String(parsed.toolName),
              status: "running",
              artifactRefs: [{ id: artifactId, kind: artifact.kind }],
              data: { adapterVersion: runnerTool.adapterVersion, transport: "fly" },
            },
          });
          if (!artifactCallback.ok) {
            json(response, 409, {
              ok: false,
              error: {
                code: "publication_revoked",
                message: "Runner publication authority was revoked.",
                retryable: false,
                redacted: true,
              },
              runner: parsed.runner,
            });
            return;
          }
        }
      }
      json(
        response,
        result.ok ? 200 : result.error.code === "sandbox_egress_not_allowed" ? 403 : 502,
        {
          ...result,
          runner: parsed.runner,
          metrics: {
            transport: "fly",
            durationMs: Date.now() - startedAt,
            callback: parsed.callback ? { status: "progress_published" } : { status: "skipped" },
          },
        },
      );
    } catch (error) {
      Sentry.captureException(error, {
        tags: { "gateway.operation": "runner.invoke" },
        extra: {
          errorCode:
            error && typeof error === "object" && "code" in error && typeof error.code === "string"
              ? error.code
              : "runner_execution_failed",
        },
      });
      json(response, 502, {
        ok: false,
        error: {
          code:
            error && typeof error === "object" && "code" in error && typeof error.code === "string"
              ? error.code
              : "runner_execution_failed",
          message: error instanceof Error ? error.message : "Runner execution failed.",
          retryable: false,
          redacted: true,
        },
        runner: parsed.runner,
        metrics: { transport: "fly", durationMs: Date.now() - startedAt },
      });
    }
    return;
  }
};

const headersToForward = (request: IncomingMessage) => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (!value || key === "host" || key === "content-length") continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  headers.delete("x-api-key");
  headers.delete("authorization");
  return headers;
};

const proxyToLangGraph = async (request: IncomingMessage, response: ServerResponse, url: URL) => {
  if (!requireProxyAuth(request, response)) return;

  const method = request.method ?? "GET";
  const body = ["GET", "HEAD"].includes(method) ? undefined : await readBody(request);
  const upstreamResponse = await fetch(`${langGraphUpstreamUrl}${url.pathname}${url.search}`, {
    method,
    headers: headersToForward(request),
    body,
  });

  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.delete("transfer-encoding");

  response.writeHead(upstreamResponse.status, Object.fromEntries(responseHeaders.entries()));
  if (upstreamResponse.body) {
    Readable.fromWeb(upstreamResponse.body as unknown as NodeReadableStream).pipe(response);
    return;
  }
  response.end();
};

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (
      syntheticConformanceMode &&
      request.method === "GET" &&
      url.pathname === "/e2e/oauth/authorize"
    ) {
      const redirectUri = new URL(url.searchParams.get("redirect_uri") ?? "");
      if (!["localhost", "127.0.0.1"].includes(redirectUri.hostname)) {
        json(response, 400, { ok: false, error: "redirect_not_permitted" });
        return;
      }
      const state = url.searchParams.get("state") ?? "";
      const challenge = url.searchParams.get("code_challenge") ?? "";
      if (!state || !challenge || url.searchParams.get("code_challenge_method") !== "S256") {
        json(response, 400, { ok: false, error: "pkce_required" });
        return;
      }
      const code = `e2e-code-${crypto.randomUUID()}`;
      e2eOAuthCodes.set(code, challenge);
      redirectUri.searchParams.set("state", state);
      redirectUri.searchParams.set("code", code);
      response.writeHead(302, { location: redirectUri.toString(), "cache-control": "no-store" });
      response.end();
      return;
    }

    if (
      syntheticConformanceMode &&
      request.method === "POST" &&
      url.pathname === "/e2e/oauth/token"
    ) {
      const form = new URLSearchParams((await readBody(request)).toString("utf8"));
      if (form.get("grant_type") === "refresh_token") {
        json(response, 200, {
          access_token: `e2e-access-${crypto.randomUUID()}`,
          refresh_token: form.get("refresh_token"),
          token_type: "Bearer",
          expires_in: 3600,
          scope: "observe propose",
        });
        return;
      }
      const code = form.get("code") ?? "";
      const verifier = form.get("code_verifier") ?? "";
      const expected = e2eOAuthCodes.get(code);
      const actual = createHash("sha256").update(verifier).digest("base64url");
      if (!expected || !constantTimeEqual(expected, actual)) {
        json(response, 400, { ok: false, error: "invalid_grant" });
        return;
      }
      e2eOAuthCodes.delete(code);
      json(response, 200, {
        access_token: `e2e-access-${crypto.randomUUID()}`,
        refresh_token: `e2e-refresh-${crypto.randomUUID()}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "observe propose",
      });
      return;
    }

    if (syntheticConformanceMode && request.method === "POST" && url.pathname === "/e2e/actions") {
      if (!request.headers.authorization) {
        json(response, 401, { ok: false, error: "credential_required" });
        return;
      }
      const body = parseJsonBuffer<{
        idempotencyKey?: string;
        outcome?: string;
        delayMs?: number;
        reconcile?: boolean;
      }>(await readBody(request));
      const idempotencyKey = body?.idempotencyKey?.trim() ?? "";
      if (!idempotencyKey) {
        json(response, 400, { ok: false, error: "idempotency_key_required" });
        return;
      }
      if (body?.reconcile === true) {
        const existing = e2eSyntheticActions.get(idempotencyKey);
        // Reconciliation is an idempotent ensure operation, not a process-local lookup.
        // This keeps the synthetic provider correct when Fly routes the original action
        // and its reconciliation request to different machines.
        const externalReference = existing?.externalReference ?? `synthetic:${idempotencyKey}`;
        e2eSyntheticActions.set(idempotencyKey, { externalReference });
        json(response, 200, {
          ok: true,
          found: true,
          status: "executed",
          externalReference,
          replayed: !existing,
        });
        return;
      }
      if (typeof body?.delayMs === "number" && body.delayMs > 0) {
        await delay(Math.min(10_000, Math.trunc(body.delayMs)));
      }
      const existing = e2eSyntheticActions.get(idempotencyKey);
      const externalReference = existing?.externalReference ?? `synthetic:${idempotencyKey}`;
      e2eSyntheticActions.set(idempotencyKey, { externalReference });
      json(response, 200, {
        ok: true,
        status: body?.outcome === "unknown" ? "accepted" : "executed",
        externalReference,
        duplicate: Boolean(existing),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/health/live") {
      json(response, 200, {
        ok: true,
        service: "operloom-langgraph-runtime",
        version: compiledWorkbenchVersion,
        gatewayReady: true,
        release: process.env.WORKBENCH_RELEASE_SHA ?? "development",
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      const langGraphReady = await isLangGraphReady();
      json(response, langGraphReady ? 200 : 503, {
        ok: langGraphReady,
        service: "operloom-langgraph-runtime",
        version: compiledWorkbenchVersion,
        langGraphReady,
        release: process.env.WORKBENCH_RELEASE_SHA ?? "development",
      });
      return;
    }

    if (url.pathname === runnerInvocationPath) {
      await handleToolRunnerInvocation(request, response, url);
      return;
    }

    await proxyToLangGraph(request, response, url);
  })().catch((error: unknown) => {
    Sentry.captureException(error, {
      tags: { "gateway.operation": "request" },
      extra: { status: 500 },
    });
    json(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "runtime gateway request failed",
    });
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`LangGraph runtime gateway listening on ${port}`);
});

server.on("error", (error) => {
  Sentry.captureException(error, { tags: { "gateway.operation": "server" } });
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void Sentry.flush(2_000).finally(() => server.close());
  });
}
