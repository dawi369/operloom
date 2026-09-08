import {
  facadeSignatureHeader,
  signFacadeRequest,
} from "../../../lib/workbench/control-plane-signing";
import type { UrlInspectResult } from "../../../lib/workbench/url-inspect";
import type { RepoSnapshotResult } from "../../../lib/workbench/repo-snapshot";
import type { RunnerEchoResult } from "../../../lib/workbench/admin-test-tools";
import type { RuntimeResult } from "@operloom/agent-sdk/control-plane";
import type { AgentIdentity, Env, ExecutionMode, TenantScope } from "./types";

export const cloudflareInlineRunnerTransport = "cloudflare_inline";
export const flyRunnerTransport = "fly";

export type ToolRunnerTransport =
  | typeof cloudflareInlineRunnerTransport
  | typeof flyRunnerTransport;

export type ToolRunnerSource = "admin" | "approval" | "model" | "demo-compat" | "agent-pack";

export type ToolRunnerMetadata = {
  transport: ToolRunnerTransport;
  adapterVersion: string;
  source: ToolRunnerSource;
  sandbox?: ToolRunnerSandboxContract;
};

export type ToolRunnerSandboxContract = {
  lifecycle: {
    template: string;
    setup: "per_invocation";
    workspaceState: "none" | "persistent";
    filesystem: "ephemeral" | "workspace_persistent";
    artifactPromotion: "metadata_only" | "explicit";
  };
  network: {
    egress: "public_web" | "none";
    allowedSchemes: Array<"http" | "https">;
    allowedHosts: string[];
    deniedHosts: string[];
    privateNetwork: "deny";
    enforcement: "control_plane_and_runner";
  };
  limits: {
    maxRuntimeMs?: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    maxArtifactBytes?: number;
  };
};

export const noEgressSandboxContract = (input: {
  template: string;
  maxRuntimeMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxArtifactBytes?: number;
}): ToolRunnerSandboxContract => ({
  lifecycle: {
    template: input.template,
    setup: "per_invocation",
    workspaceState: "none",
    filesystem: "ephemeral",
    artifactPromotion: "metadata_only",
  },
  network: {
    egress: "none",
    allowedSchemes: [],
    allowedHosts: [],
    deniedHosts: ["*"],
    privateNetwork: "deny",
    enforcement: "control_plane_and_runner",
  },
  limits: {
    maxRuntimeMs: input.maxRuntimeMs,
    maxStdoutBytes: input.maxStdoutBytes,
    maxStderrBytes: input.maxStderrBytes,
    maxArtifactBytes: input.maxArtifactBytes,
  },
});

export type ToolAdapterMetadata = {
  toolName: string;
  adapterVersion: string;
  supportedExecutionModes: ExecutionMode[];
  transport: ToolRunnerTransport;
};

export const runnerMetadataFor = (
  adapter: ToolAdapterMetadata,
  source: ToolRunnerSource,
  transport: ToolRunnerTransport = adapter.transport,
  sandbox?: ToolRunnerSandboxContract,
): ToolRunnerMetadata => ({
  transport,
  adapterVersion: adapter.adapterVersion,
  source,
  sandbox,
});

const normalizePatterns = (patterns?: string[]) =>
  Array.isArray(patterns)
    ? Array.from(
        new Set(
          patterns
            .map((pattern) => pattern.trim().toLowerCase())
            .filter((pattern) => pattern.length > 0)
            .slice(0, 64),
        ),
      )
    : [];

export const urlInspectSandboxContract = (input?: {
  allowlist?: string[];
  denylist?: string[];
  maxRuntimeMs?: number;
}): ToolRunnerSandboxContract => ({
  lifecycle: {
    template: "url-inspect-v1",
    setup: "per_invocation",
    workspaceState: "none",
    filesystem: "ephemeral",
    artifactPromotion: "metadata_only",
  },
  network: {
    egress: "public_web",
    allowedSchemes: ["http", "https"],
    allowedHosts: normalizePatterns(input?.allowlist),
    deniedHosts: normalizePatterns(input?.denylist),
    privateNetwork: "deny",
    enforcement: "control_plane_and_runner",
  },
  limits: {
    maxRuntimeMs: input?.maxRuntimeMs,
  },
});

export const repoSnapshotSandboxContract = (input?: {
  maxRuntimeMs?: number;
}): ToolRunnerSandboxContract =>
  noEgressSandboxContract({
    template: "repo-snapshot-v1",
    maxRuntimeMs: input?.maxRuntimeMs,
    maxStdoutBytes: 65_536,
    maxStderrBytes: 16_384,
    maxArtifactBytes: 131_072,
  });

export const runnerEchoSandboxContract = (input?: {
  maxRuntimeMs?: number;
}): ToolRunnerSandboxContract =>
  noEgressSandboxContract({
    template: "runner-echo-v1",
    maxRuntimeMs: input?.maxRuntimeMs,
    maxStdoutBytes: 4_096,
    maxStderrBytes: 4_096,
    maxArtifactBytes: 0,
  });

export type ToolRunnerExecution = {
  mode: ExecutionMode;
  policy: string;
};

export type ToolRunnerCallbackContext = {
  url: string;
  protocolVersion: "workflow-callback-v0";
  traceId?: string | null;
};

export type ToolRunnerInvocation = {
  scope: TenantScope;
  agentId: string;
  runId: string;
  workflowIntentId: string;
  toolCallId?: string;
  packVersion?: string;
  runtimeVersion?: string;
  bindingVersion?: number;
  toolName: string;
  execution: ToolRunnerExecution;
  input: Record<string, unknown>;
  runner: ToolRunnerMetadata;
  callback?: ToolRunnerCallbackContext;
  connectionCapability?: {
    url: string;
    token: string;
    connectionId: string;
    allowedUrl: string;
    allowedMethod: string;
    expiresAt: string;
  };
  policyDecisionId?: string;
  source?: ToolRunnerSource;
  traceId?: string | null;
};

export type ToolRunnerInvocationResponse = (
  | UrlInspectResult
  | RepoSnapshotResult
  | RunnerEchoResult
  | RuntimeResult
) & {
  runner?: ToolRunnerMetadata;
  metrics?: Record<string, unknown>;
};

const runnerInvocationPath = "/workbench/tool-runners/invocations";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parsedRunnerErrorCode = (value: unknown) => {
  if (!isRecord(value)) return undefined;
  const error = isRecord(value.error) ? value.error : null;
  const details = isRecord(value.details) ? value.details : null;
  return typeof error?.code === "string"
    ? error.code
    : typeof details?.code === "string"
      ? details.code
      : undefined;
};

const parsedRunnerErrorMessage = (value: unknown) => {
  if (!isRecord(value)) return undefined;
  const error = isRecord(value.error) ? value.error : null;
  const details = isRecord(value.details) ? value.details : null;
  const source =
    error && error.redacted === true
      ? error
      : details && details.redacted === true
        ? details
        : null;
  return typeof source?.message === "string" && source.message ? source.message : undefined;
};

const safeRunnerDispatchErrorCode = (toolName: string, code?: string) => {
  if (code === "runner_callback_signing_not_configured") return code;
  if (code === "runner_request_failed") return code;
  if (toolName === "repo.snapshot" && code === "repo_snapshot_failed") return code;
  if (toolName === "runner.echo" && code === "test_tool_failed") return code;
  return "runner_request_failed";
};

export const isFlyRunnerConfigured = (env: Env) =>
  env.WORKBENCH_RUNNER_TRANSPORT === flyRunnerTransport &&
  Boolean(env.WORKBENCH_RUNNER_URL?.trim()) &&
  Boolean(env.WORKBENCH_RUNNER_SIGNING_SECRET?.trim());

export const resolveConfiguredRunnerTransport = (env: Env): ToolRunnerTransport =>
  isFlyRunnerConfigured(env) ? flyRunnerTransport : cloudflareInlineRunnerTransport;

export const invokeFlyToolRunner = async (
  env: Env,
  identity: AgentIdentity,
  invocation: ToolRunnerInvocation,
): Promise<ToolRunnerInvocationResponse> => {
  const endpoint = env.WORKBENCH_RUNNER_URL?.trim();
  const secret = env.WORKBENCH_RUNNER_SIGNING_SECRET?.trim();
  if (!endpoint || !secret) {
    return {
      ok: false,
      error: {
        code: "runner_not_configured",
        message: "Fly runner transport is not configured.",
        retryable: false,
        redacted: true,
      },
      runner: invocation.runner,
    };
  }

  const body = JSON.stringify(invocation);
  const startedAtMs = Date.now();
  const url = new URL(endpoint);
  const pathWithQuery = `${url.pathname}${url.search}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-assistant-mk1-user-id": identity.scope.userId,
    "x-assistant-mk1-workspace-id": identity.scope.workspaceId,
    "x-assistant-mk1-agent-id": identity.agentId,
    "x-assistant-mk1-run-id": invocation.runId,
    "x-assistant-mk1-workflow-intent-id": invocation.workflowIntentId,
    "x-assistant-mk1-tool-name": invocation.toolName,
  };

  Object.assign(
    headers,
    await signFacadeRequest({
      secret,
      method: "POST",
      pathWithQuery,
      body,
      headers,
    }),
  );

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "POST",
      headers,
      body,
    });
  } catch {
    console.warn("tool_runner.dispatch_failed", {
      component: "cloudflare-control-plane",
      event: "runner.dispatch.failed",
      toolName: invocation.toolName,
      runId: invocation.runId,
      workflowIntentId: invocation.workflowIntentId,
      status: "network_error",
      code: "runner_request_failed",
      durationMs: Math.max(0, Math.round(Date.now() - startedAtMs)),
    });
    return {
      ok: false,
      error: {
        code: "runner_request_failed",
        message: "Fly runner request failed before a response was available.",
        retryable: true,
        redacted: true,
      },
      runner: invocation.runner,
      metrics: {
        status: "network_error",
        code: "runner_request_failed",
        durationMs: Math.max(0, Math.round(Date.now() - startedAtMs)),
      },
    };
  }

  const parsed = await response.json().catch(() => null);
  if (!response.ok) {
    const runnerCode = parsedRunnerErrorCode(parsed);
    const code = safeRunnerDispatchErrorCode(invocation.toolName, runnerCode);
    const durationMs = Math.max(0, Math.round(Date.now() - startedAtMs));
    const runnerMessage = parsedRunnerErrorMessage(parsed);
    const runnerMetrics = isRecord(parsed) && isRecord(parsed.metrics) ? parsed.metrics : {};
    console.warn("tool_runner.dispatch_failed", {
      component: "cloudflare-control-plane",
      event: "runner.dispatch.failed",
      toolName: invocation.toolName,
      runId: invocation.runId,
      workflowIntentId: invocation.workflowIntentId,
      status: response.status,
      code,
      runnerCode,
      durationMs,
    });
    return {
      ok: false,
      error: {
        code,
        message: runnerMessage ?? `Fly runner request failed with ${response.status}.`,
        retryable: response.status >= 500,
        redacted: true,
      },
      runner: invocation.runner,
      metrics: {
        ...runnerMetrics,
        status: response.status,
        durationMs,
        code,
        runnerCode,
      },
    };
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as { ok?: unknown }).ok !== "boolean"
  ) {
    return {
      ok: false,
      error: {
        code: "runner_invalid_response",
        message: "Fly runner returned an invalid response.",
        retryable: true,
        redacted: true,
      },
      runner: invocation.runner,
    };
  }

  return parsed as ToolRunnerInvocationResponse;
};

export const runnerSignatureHeader = facadeSignatureHeader;
export const runnerInvocationEndpointPath = runnerInvocationPath;
