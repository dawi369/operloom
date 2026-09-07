import { agentManifestRegistry } from "../generated/agent-runtime/manifests";
import { agentRunnerRegistry } from "../generated/agent-runtime/runner";
import { facadeSignatureHeader, signFacadeRequest } from "../lib/workbench/control-plane-signing";
import { runSmoke } from "./smoke-utils";

const baseUrl = (process.env.LANGGRAPH_RUNTIME_BASE_URL ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);
const runnerCallbackUrl = process.env.WORKBENCH_RUNNER_CALLBACK_URL?.trim();
const signingSecret = process.env.WORKBENCH_RUNNER_SIGNING_SECRET?.trim();
if (!signingSecret) {
  throw new Error("WORKBENCH_RUNNER_SIGNING_SECRET is required for Fly runner smoke");
}

const path = "/workbench/tool-runners/invocations";
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const scope = {
  userId: `runner-user-${suffix}`,
  workspaceId: `workspace:workos-org:runner-org-${suffix}:default`,
};

const sandbox = (allowedHosts = ["example.com"]) => ({
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
    allowedHosts,
    deniedHosts: [],
    privateNetwork: "deny",
    enforcement: "control_plane_and_runner",
  },
  limits: {},
});

const repoSnapshotSandbox = () => ({
  lifecycle: {
    template: "repo-snapshot-v1",
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
    maxRuntimeMs: 10_000,
    maxStdoutBytes: 65_536,
    maxStderrBytes: 16_384,
    maxArtifactBytes: 131_072,
  },
});

const runnerEchoSandbox = () => ({
  lifecycle: {
    template: "runner-echo-v1",
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
    maxRuntimeMs: 5_000,
    maxStdoutBytes: 4_096,
    maxStderrBytes: 4_096,
    maxArtifactBytes: 0,
  },
});

const contract = (toolName: string) => {
  const entry = Object.values(agentRunnerRegistry).find((entry) =>
    entry.module.tools.some((tool) => tool.id === toolName),
  );
  const manifest = entry
    ? agentManifestRegistry[entry.module.packId as keyof typeof agentManifestRegistry]
    : undefined;
  return {
    packVersion: manifest?.module.version ?? "1.0.0",
    runtimeVersion: entry?.module.runtimeVersion ?? "1.0.0",
    bindingVersion: 1,
  };
};

const invocationBody = (
  runId = `cf-run-${suffix}`,
  input: { url: string } = { url: "https://example.com" },
  allowedHosts = ["example.com"],
) =>
  JSON.stringify({
    scope,
    agentId: `agent:${scope.workspaceId}:default`,
    runId,
    workflowIntentId: `cf-intent-${suffix}`,
    toolName: "url.inspect",
    ...contract("url.inspect"),
    execution: { mode: "dry_run", policy: "tool-admin-readonly-v0" },
    input,
    runner: {
      transport: "fly",
      adapterVersion: "url-inspect-v1",
      source: "admin",
      sandbox: sandbox(allowedHosts),
    },
    policyDecisionId: `cf-policy-${suffix}`,
    source: "admin",
  });

const repoSnapshotInvocationBody = (runId = `cf-run-repo-snapshot-${suffix}`) =>
  JSON.stringify({
    scope,
    agentId: `agent:${scope.workspaceId}:default`,
    runId,
    workflowIntentId: `cf-intent-repo-snapshot-${suffix}`,
    toolName: "repo.snapshot",
    ...contract("repo.snapshot"),
    execution: { mode: "dry_run", policy: "repo-snapshot-readonly-v0" },
    input: { includeDocs: true, includeScripts: true, includeConfig: true },
    runner: {
      transport: "fly",
      adapterVersion: "repo-snapshot-v1",
      source: "admin",
      sandbox: repoSnapshotSandbox(),
    },
    policyDecisionId: `cf-policy-repo-snapshot-${suffix}`,
    source: "admin",
    traceId: `cf-trace-repo-snapshot-${suffix}`,
    callback: runnerCallbackUrl
      ? {
          url: runnerCallbackUrl,
          protocolVersion: "workflow-callback-v0",
          traceId: `cf-trace-repo-snapshot-${suffix}`,
        }
      : undefined,
  });

const runnerEchoInvocationBody = (runId = `cf-run-runner-echo-${suffix}`) =>
  JSON.stringify({
    scope,
    agentId: `agent:${scope.workspaceId}:default`,
    runId,
    workflowIntentId: `cf-intent-runner-echo-${suffix}`,
    toolName: "runner.echo",
    ...contract("runner.echo"),
    execution: { mode: "dry_run", policy: "admin-conformance-runner-echo-v0" },
    input: { message: "runner smoke", uppercase: true },
    runner: {
      transport: "fly",
      adapterVersion: "runner-echo-v1",
      source: "admin",
      sandbox: runnerEchoSandbox(),
    },
    policyDecisionId: `cf-policy-runner-echo-${suffix}`,
    source: "admin",
    traceId: `cf-trace-runner-echo-${suffix}`,
    callback: runnerCallbackUrl
      ? {
          url: runnerCallbackUrl,
          protocolVersion: "workflow-callback-v0",
          traceId: `cf-trace-runner-echo-${suffix}`,
        }
      : undefined,
  });

const operatorSnapshotInvocationBody = (runId = `cf-run-operator-snapshot-${suffix}`) =>
  JSON.stringify({
    scope,
    agentId: `agent:${scope.workspaceId}:default`,
    runId,
    workflowIntentId: `cf-intent-operator-snapshot-${suffix}`,
    toolName: "operator.snapshot",
    ...contract("operator.snapshot"),
    execution: { mode: "dry_run", policy: "operator.snapshot.v1" },
    input: { subject: "runner-conformance" },
    runner: {
      transport: "fly",
      adapterVersion: "operator-snapshot-v1",
      source: "agent-pack",
      sandbox: {
        ...repoSnapshotSandbox(),
        lifecycle: { ...repoSnapshotSandbox().lifecycle, template: "operator-snapshot-v1" },
      },
    },
    source: "agent-pack",
  });

const signedFetch = async (input?: {
  body?: string;
  runId?: string;
  workflowIntentId?: string;
  toolName?: string;
  timestamp?: string;
  nonce?: string;
  tamper?: (headers: Record<string, string>) => void;
}) => {
  const body = input?.body ?? invocationBody();
  const runId = input?.runId ?? `cf-run-${suffix}`;
  const workflowIntentId = input?.workflowIntentId ?? `cf-intent-${suffix}`;
  const toolName = input?.toolName ?? "url.inspect";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-assistant-mk1-user-id": scope.userId,
    "x-assistant-mk1-workspace-id": scope.workspaceId,
    "x-assistant-mk1-agent-id": `agent:${scope.workspaceId}:default`,
    "x-assistant-mk1-run-id": runId,
    "x-assistant-mk1-workflow-intent-id": workflowIntentId,
    "x-assistant-mk1-tool-name": toolName,
  };
  Object.assign(
    headers,
    await signFacadeRequest({
      secret: signingSecret,
      method: "POST",
      pathWithQuery: path,
      body,
      headers,
      timestamp: input?.timestamp,
      nonce: input?.nonce,
    }),
  );
  input?.tamper?.(headers);
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body,
  });
};

const signedRepoSnapshotFetch = (input?: { nonce?: string }) =>
  signedFetch({
    body: repoSnapshotInvocationBody(),
    runId: `cf-run-repo-snapshot-${suffix}`,
    workflowIntentId: `cf-intent-repo-snapshot-${suffix}`,
    toolName: "repo.snapshot",
    nonce: input?.nonce,
  });

const signedRunnerEchoFetch = (input?: { nonce?: string }) =>
  signedFetch({
    body: runnerEchoInvocationBody(),
    runId: `cf-run-runner-echo-${suffix}`,
    workflowIntentId: `cf-intent-runner-echo-${suffix}`,
    toolName: "runner.echo",
    nonce: input?.nonce,
  });

const signedOperatorSnapshotFetch = (input?: { nonce?: string }) =>
  signedFetch({
    body: operatorSnapshotInvocationBody(),
    runId: `cf-run-operator-snapshot-${suffix}`,
    workflowIntentId: `cf-intent-operator-snapshot-${suffix}`,
    toolName: "operator.snapshot",
    nonce: input?.nonce,
  });

const expectRunnerAuthError = async (response: Response, code: string) => {
  if (response.status !== 401) {
    throw new Error(`expected 401 ${code}, got ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as { details?: { code?: string } };
  if (body.details?.code !== code) {
    throw new Error(`expected ${code}, got ${JSON.stringify(body)}`);
  }
};

runSmoke("Fly tool runner smoke", async () => {
  console.log(`Smoking Fly tool runner at ${baseUrl}`);

  const valid = await signedFetch({ nonce: `valid-${suffix}` });
  if (!valid.ok) {
    throw new Error(`valid runner request failed with ${valid.status}: ${await valid.text()}`);
  }
  const validBody = (await valid.json()) as {
    ok?: boolean;
    output?: { status?: number; finalUrl?: string };
    runner?: {
      transport?: string;
      adapterVersion?: string;
      sandbox?: { network?: { privateNetwork?: string } };
    };
  };
  if (
    !validBody.ok ||
    validBody.output?.status !== 200 ||
    validBody.runner?.transport !== "fly" ||
    validBody.runner.adapterVersion !== "url-inspect-v1" ||
    validBody.runner.sandbox?.network?.privateNetwork !== "deny"
  ) {
    throw new Error(`valid runner response was unexpected: ${JSON.stringify(validBody)}`);
  }

  const repoSnapshot = await signedRepoSnapshotFetch({ nonce: `repo-snapshot-${suffix}` });
  if (!repoSnapshot.ok) {
    throw new Error(`repo.snapshot runner request failed: ${repoSnapshot.status}`);
  }
  const repoSnapshotBody = (await repoSnapshot.json()) as {
    ok?: boolean;
    output?: { status?: string; repoFiles?: string[]; commandMetrics?: unknown[] };
    runner?: {
      transport?: string;
      adapterVersion?: string;
      sandbox?: { network?: { egress?: string; privateNetwork?: string } };
    };
    metrics?: { callback?: { status?: string } };
  };
  if (
    !repoSnapshotBody.ok ||
    repoSnapshotBody.output?.status !== "ok" ||
    !Array.isArray(repoSnapshotBody.output.repoFiles) ||
    !Array.isArray(repoSnapshotBody.output.commandMetrics) ||
    repoSnapshotBody.runner?.transport !== "fly" ||
    repoSnapshotBody.runner.adapterVersion !== "repo-snapshot-v1" ||
    repoSnapshotBody.runner.sandbox?.network?.egress !== "none" ||
    repoSnapshotBody.runner.sandbox.network.privateNetwork !== "deny" ||
    (runnerCallbackUrl && repoSnapshotBody.metrics?.callback?.status !== "completed")
  ) {
    throw new Error(`repo.snapshot response was unexpected: ${JSON.stringify(repoSnapshotBody)}`);
  }

  const runnerEcho = await signedRunnerEchoFetch({ nonce: `runner-echo-${suffix}` });
  if (!runnerEcho.ok) {
    throw new Error(`runner.echo runner request failed: ${runnerEcho.status}`);
  }
  const runnerEchoBody = (await runnerEcho.json()) as {
    ok?: boolean;
    output?: { status?: string; echoed?: string; length?: number };
    runner?: {
      transport?: string;
      adapterVersion?: string;
      sandbox?: { network?: { egress?: string; privateNetwork?: string } };
    };
    metrics?: { callback?: { status?: string } };
  };
  if (
    !runnerEchoBody.ok ||
    runnerEchoBody.output?.status !== "ok" ||
    runnerEchoBody.output.echoed !== "RUNNER SMOKE" ||
    runnerEchoBody.output.length !== "RUNNER SMOKE".length ||
    runnerEchoBody.runner?.transport !== "fly" ||
    runnerEchoBody.runner.adapterVersion !== "runner-echo-v1" ||
    runnerEchoBody.runner.sandbox?.network?.egress !== "none" ||
    runnerEchoBody.runner.sandbox.network.privateNetwork !== "deny" ||
    (runnerCallbackUrl && runnerEchoBody.metrics?.callback?.status !== "completed")
  ) {
    throw new Error(`runner.echo response was unexpected: ${JSON.stringify(runnerEchoBody)}`);
  }

  const operatorSnapshot = await signedOperatorSnapshotFetch({
    nonce: `operator-snapshot-${suffix}`,
  });
  if (!operatorSnapshot.ok) {
    throw new Error(`operator.snapshot runner request failed: ${operatorSnapshot.status}`);
  }
  const operatorSnapshotBody = (await operatorSnapshot.json()) as {
    ok?: boolean;
    output?: { subject?: string; status?: string };
    runner?: { adapterVersion?: string };
  };
  if (
    !operatorSnapshotBody.ok ||
    operatorSnapshotBody.output?.subject !== "runner-conformance" ||
    operatorSnapshotBody.output.status !== "nominal" ||
    operatorSnapshotBody.runner?.adapterVersion !== "operator-snapshot-v1"
  ) {
    throw new Error(
      `operator.snapshot response was unexpected: ${JSON.stringify(operatorSnapshotBody)}`,
    );
  }

  const blockedEgress = await signedFetch({
    body: invocationBody(`cf-run-blocked-egress-${suffix}`, { url: "https://example.com" }, [
      "allowed.example",
    ]),
    nonce: `blocked-egress-${suffix}`,
  });
  if (blockedEgress.status !== 403) {
    throw new Error(`expected sandbox egress block, got ${blockedEgress.status}`);
  }
  const blockedEgressBody = (await blockedEgress.json()) as { error?: { code?: string } };
  if (blockedEgressBody.error?.code !== "sandbox_egress_not_allowed") {
    throw new Error(`sandbox egress block missing code: ${JSON.stringify(blockedEgressBody)}`);
  }

  const missingSandboxBody = JSON.stringify({
    scope,
    agentId: `agent:${scope.workspaceId}:default`,
    runId: `cf-run-missing-sandbox-${suffix}`,
    workflowIntentId: `cf-intent-${suffix}`,
    toolName: "url.inspect",
    ...contract("url.inspect"),
    execution: { mode: "dry_run", policy: "tool-admin-readonly-v0" },
    input: { url: "https://example.com" },
    runner: {
      transport: "fly",
      adapterVersion: "url-inspect-v1",
      source: "admin",
    },
    policyDecisionId: `cf-policy-${suffix}`,
    source: "admin",
  });
  const missingSandbox = await signedFetch({
    body: missingSandboxBody,
    nonce: `missing-sandbox-${suffix}`,
  });
  if (missingSandbox.status !== 403) {
    throw new Error(`expected missing sandbox block, got ${missingSandbox.status}`);
  }
  const missingSandboxResponse = (await missingSandbox.json()) as { error?: { code?: string } };
  if (missingSandboxResponse.error?.code !== "sandbox_required") {
    throw new Error(
      `missing sandbox block missing code: ${JSON.stringify(missingSandboxResponse)}`,
    );
  }

  const scopeTampered = await signedFetch({
    nonce: `scope-tamper-${suffix}`,
    tamper: (headers) => {
      headers["x-assistant-mk1-workspace-id"] = "other-workspace";
    },
  });
  await expectRunnerAuthError(scopeTampered, "signature_invalid");

  const unsigned = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-assistant-mk1-user-id": scope.userId,
    },
    body: invocationBody(`cf-run-unsigned-${suffix}`),
  });
  await expectRunnerAuthError(unsigned, "signature_required");

  const stale = await signedFetch({
    timestamp: String(Date.now() - 10 * 60 * 1000),
    nonce: `stale-${suffix}`,
  });
  await expectRunnerAuthError(stale, "signature_stale");

  const replayBody = invocationBody(`cf-run-replay-${suffix}`);
  const replayTimestamp = String(Date.now());
  const replayNonce = `replay-${suffix}`;
  const replayHeaders: Record<string, string> = {
    "content-type": "application/json",
    "x-assistant-mk1-user-id": scope.userId,
    "x-assistant-mk1-workspace-id": scope.workspaceId,
    "x-assistant-mk1-agent-id": `agent:${scope.workspaceId}:default`,
    "x-assistant-mk1-run-id": `cf-run-replay-${suffix}`,
    "x-assistant-mk1-workflow-intent-id": `cf-intent-${suffix}`,
    "x-assistant-mk1-tool-name": "url.inspect",
  };
  Object.assign(
    replayHeaders,
    await signFacadeRequest({
      secret: signingSecret,
      method: "POST",
      pathWithQuery: path,
      body: replayBody,
      headers: replayHeaders,
      timestamp: replayTimestamp,
      nonce: replayNonce,
    }),
  );
  const firstReplay = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: replayHeaders,
    body: replayBody,
  });
  if (!firstReplay.ok) {
    throw new Error(`first replay request should succeed: ${firstReplay.status}`);
  }
  const secondReplay = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: replayHeaders,
    body: replayBody,
  });
  await expectRunnerAuthError(secondReplay, "signature_replay");

  const tamperedBody = await signedFetch({
    body: invocationBody(`cf-run-body-${suffix}`),
    nonce: `body-${suffix}`,
  });
  if (!tamperedBody.ok) {
    throw new Error(`body baseline should succeed: ${tamperedBody.status}`);
  }
  const signedBody = invocationBody(`cf-run-body-mismatch-${suffix}`);
  const tamperHeaders: Record<string, string> = {
    "content-type": "application/json",
    "x-assistant-mk1-user-id": scope.userId,
    "x-assistant-mk1-workspace-id": scope.workspaceId,
    "x-assistant-mk1-agent-id": `agent:${scope.workspaceId}:default`,
    "x-assistant-mk1-run-id": `cf-run-body-mismatch-${suffix}`,
    "x-assistant-mk1-workflow-intent-id": `cf-intent-${suffix}`,
    "x-assistant-mk1-tool-name": "url.inspect",
  };
  Object.assign(
    tamperHeaders,
    await signFacadeRequest({
      secret: signingSecret,
      method: "POST",
      pathWithQuery: path,
      body: signedBody,
      headers: tamperHeaders,
      nonce: `body-mismatch-${suffix}`,
    }),
  );
  const bodyMismatch = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: tamperHeaders,
    body: invocationBody(`cf-run-body-mismatch-tampered-${suffix}`),
  });
  await expectRunnerAuthError(bodyMismatch, "body_hash_mismatch");

  const invalid = await signedFetch({
    nonce: `invalid-${suffix}`,
    tamper: (headers) => {
      headers["x-assistant-mk1-user-id"] = `tampered-${scope.userId}`;
    },
  });
  await expectRunnerAuthError(invalid, "signature_invalid");

  const missing = await signedFetch({
    nonce: `missing-${suffix}`,
    tamper: (headers) => {
      delete headers[facadeSignatureHeader];
    },
  });
  await expectRunnerAuthError(missing, "signature_required");

  console.log(
    JSON.stringify(
      {
        runId: `cf-run-${suffix}`,
        replayTimestamp,
      },
      null,
      2,
    ),
  );
});

export {};
