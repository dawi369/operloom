import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { createSmokeContext, defaultWorkspaceId, sleep, type TenantIdentity } from "./smoke-utils";
import { renderEnvironmentConfig } from "./render-environment-config";
import { isEnvironmentTarget } from "./workbench-environment";

const execFileAsync = promisify(execFile);
const commit = process.env.GITHUB_SHA?.trim();
const requestedTarget = process.env.WORKBENCH_ENVIRONMENT?.trim() ?? "";
const webOrigin = process.env.HOSTED_WEB_ORIGIN?.trim().replace(/\/$/, "");
const signingSecret = process.env.CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET?.trim();
const enabled = process.env.WORKBENCH_HOSTED_DRILL_MODE === "true";
const pollTimeoutMs = Number(process.env.HOSTED_DRILL_TIMEOUT_MS ?? 120_000);
const pollIntervalMs = 250;

if (!enabled) throw new Error("WORKBENCH_HOSTED_DRILL_MODE=true is required");
if (!isEnvironmentTarget(requestedTarget) || requestedTarget === "local") {
  throw new Error("WORKBENCH_ENVIRONMENT must be acceptance|production");
}
const rendered = renderEnvironmentConfig(requestedTarget);
const flyAppName = process.env.HOSTED_FLY_APP?.trim() || rendered.manifest.fly.appName;
if (!commit || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("GITHUB_SHA must be a full commit");
if (!webOrigin) throw new Error("HOSTED_WEB_ORIGIN is required");
if (!signingSecret) {
  throw new Error("CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET is required");
}
if (!Number.isFinite(pollTimeoutMs) || pollTimeoutMs < 30_000 || pollTimeoutMs > 300_000) {
  throw new Error("HOSTED_DRILL_TIMEOUT_MS must be between 30000 and 300000");
}

type Agent = { id: string; name?: string };
type Trigger = {
  id: string;
  packTriggerId: string;
  status: string;
  publicId?: string;
};
type Dispatch = {
  id: string;
  triggerId: string;
  status: string;
  source: string;
  attemptCount: number;
  runId?: string;
  previousRunId?: string;
  error?: Record<string, unknown>;
};
type RunSnapshot = {
  snapshot?: {
    run?: { id?: string; status?: string; data?: Record<string, unknown> };
    artifacts?: Array<{ id?: string; storageProvider?: string }>;
  };
};
type OperatorAlert = {
  id: string;
  status: string;
  code: string;
  targetId?: string;
  deliveryStatus: string;
  deliveryAttempts: number;
};

const { baseUrl, readJson } = createSmokeContext({
  pollTimeoutDefault: pollTimeoutMs,
  pollIntervalDefault: pollIntervalMs,
});
const shortCommit = commit.slice(0, 8);
const suffix = `${shortCommit}-${Date.now().toString(36)}`;
const accountId = `workos-org:hosted-level3-${suffix}`;
const workspaceId = defaultWorkspaceId(accountId);
const owner: TenantIdentity = {
  userId: `hosted-level3-owner-${suffix}`,
  accountId,
  accountSource: "workos-organization",
  workspaceId,
  email: `hosted-level3-${suffix}@example.com`,
  name: "Hosted Level 3 Drill",
  role: "owner",
  roles: ["owner"],
  permissions: ["workbench:read"],
  authMode: "workos",
  workspaceSource: "workos-organization",
};

const startedAt = new Date().toISOString();
const guarantees: Record<string, { status: "passed"; evidence: Record<string, unknown> }> = {};

const safeSql = (value: string) => `'${value.replaceAll("'", "''")}'`;

const d1Execute = async (sql: string) => {
  await execFileAsync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      rendered.manifest.cloudflare.d1DatabaseName,
      "--remote",
      "--config",
      rendered.wranglerPath,
      "--command",
      sql,
      "--yes",
    ],
    { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 },
  );
};

const poll = async <T>(
  label: string,
  read: () => Promise<T | undefined>,
  timeoutMs = pollTimeoutMs,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(pollIntervalMs);
  }
  throw new Error(`${label} did not complete within ${timeoutMs}ms`);
};

const listDispatches = async (identity: TenantIdentity, triggerId: string) => {
  const body = await readJson<{ dispatches?: Dispatch[] }>(
    `/trigger-dispatches?triggerId=${encodeURIComponent(triggerId)}&limit=100`,
    identity,
  );
  return body.dispatches ?? [];
};

const waitForDispatch = (
  identity: TenantIdentity,
  triggerId: string,
  dispatchId: string,
  statuses: string[],
  timeoutMs = pollTimeoutMs,
) =>
  poll(
    `dispatch ${dispatchId} status ${statuses.join("/")}`,
    async () => {
      const dispatch = (await listDispatches(identity, triggerId)).find(
        (candidate) => candidate.id === dispatchId,
      );
      return dispatch && statuses.includes(dispatch.status) ? dispatch : undefined;
    },
    timeoutMs,
  );

const runSnapshot = (identity: TenantIdentity, runId: string) =>
  readJson<RunSnapshot>(`/workbench/history/runs/${encodeURIComponent(runId)}`, identity);

const createTrigger = async (
  identity: TenantIdentity,
  packTriggerId: "scheduled-readiness" | "readiness-requested",
): Promise<{ trigger: Trigger; webhookSecret?: string }> => {
  const body = await readJson<{
    trigger?: Trigger;
    webhookSecret?: string;
  }>("/triggers", identity, {
    method: "POST",
    body: JSON.stringify({
      packId: "repo-analyst",
      packTriggerId,
      status: "enabled",
    }),
  });
  if (!body.trigger) throw new Error(`${packTriggerId} trigger was not created`);
  return { trigger: body.trigger, webhookSecret: body.webhookSecret };
};

const createDispatch = async (
  identity: TenantIdentity,
  triggerId: string,
  idempotencyKey: string,
) => {
  const body = await readJson<{ dispatch?: Dispatch }>(
    `/triggers/${encodeURIComponent(triggerId)}/dispatches`,
    identity,
    {
      method: "POST",
      body: JSON.stringify({ idempotencyKey, payload: {} }),
    },
  );
  if (!body.dispatch) throw new Error(`dispatch ${idempotencyKey} was not accepted`);
  return body.dispatch;
};

const stopFlyMachines = async () => {
  const { stdout } = await execFileAsync(
    "fly",
    ["machine", "list", "--app", flyAppName, "--json"],
    { maxBuffer: 2 * 1024 * 1024 },
  );
  const machines = JSON.parse(stdout) as Array<{ id?: string; state?: string }>;
  const started = machines.filter((machine) => machine.id && machine.state === "started");
  for (const machine of started) {
    await execFileAsync("fly", ["machine", "stop", machine.id!, "--app", flyAppName], {
      maxBuffer: 2 * 1024 * 1024,
    });
  }
  return started.map((machine) => machine.id!);
};

const main = async () => {
  await readJson("/admin/workspace-summary", owner);
  const pack = await readJson<{ agent?: Agent }>("/agent-packs/repo-analyst/instantiate", owner, {
    method: "POST",
  });
  if (!pack.agent?.id) throw new Error("Repository Analyst pack activation failed");
  owner.agentId = pack.agent.id;
  await readJson(`/agents/${encodeURIComponent(pack.agent.id)}/activate`, owner, {
    method: "POST",
  });

  const webhook = await createTrigger(owner, "readiness-requested");
  if (!webhook.trigger?.publicId || !webhook.webhookSecret) {
    throw new Error("hosted webhook trigger did not return one-time credentials");
  }
  const webhookKey = `hosted-duplicate-${suffix}`;
  const webhookUrl = `${webOrigin}/api/external-signals/${encodeURIComponent(
    webhook.trigger.publicId,
  )}`;
  const webhookRequest = () =>
    fetch(webhookUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${webhook.webhookSecret}`,
        "content-type": "application/json",
        "idempotency-key": webhookKey,
      },
      body: JSON.stringify({ includeDocs: true, includeScripts: true, includeConfig: true }),
    });
  const firstWebhook = await webhookRequest();
  if (firstWebhook.status !== 202) {
    throw new Error(`first webhook returned ${firstWebhook.status}: ${await firstWebhook.text()}`);
  }
  const firstWebhookBody = (await firstWebhook.json()) as { dispatchId?: string };
  const duplicateWebhook = await webhookRequest();
  const duplicateWebhookBody = (await duplicateWebhook.json()) as {
    duplicate?: boolean;
    dispatchId?: string;
  };
  if (
    duplicateWebhook.status !== 200 ||
    duplicateWebhookBody.duplicate !== true ||
    duplicateWebhookBody.dispatchId !== firstWebhookBody.dispatchId
  ) {
    throw new Error("duplicate webhook did not resolve to the canonical dispatch");
  }
  if (!firstWebhookBody.dispatchId) throw new Error("webhook dispatch id is missing");
  const webhookCompleted = await waitForDispatch(
    owner,
    webhook.trigger.id,
    firstWebhookBody.dispatchId,
    ["completed"],
  );
  const webhookDispatches = await listDispatches(owner, webhook.trigger.id);
  if (webhookDispatches.filter((item) => item.id === webhookCompleted.id).length !== 1) {
    throw new Error("duplicate webhook created more than one canonical dispatch");
  }
  guarantees.duplicate_webhook = {
    status: "passed",
    evidence: {
      triggerId: webhook.trigger.id,
      dispatchId: webhookCompleted.id,
      idempotencyKey: webhookKey,
      firstStatus: firstWebhook.status,
      duplicateStatus: duplicateWebhook.status,
    },
  };

  const schedule = await createTrigger(owner, "scheduled-readiness");
  const stoppedMachines = await stopFlyMachines();
  const cancellationKey = `hosted-cancel-${suffix}`;
  const saturationKey = `hosted-saturation-${suffix}`;
  const [cancellationReceipt, saturationReceipt] = await Promise.all([
    createDispatch(owner, schedule.trigger.id, cancellationKey),
    createDispatch(owner, schedule.trigger.id, saturationKey),
  ]);

  const activeDispatch = await poll("cold-start running dispatch", async () => {
    const dispatches = await listDispatches(owner, schedule.trigger.id);
    return dispatches.find(
      (item) =>
        [cancellationReceipt.id, saturationReceipt.id].includes(item.id) &&
        item.status === "running" &&
        item.runId,
    );
  });
  const pendingDispatchId =
    activeDispatch.id === cancellationReceipt.id ? saturationReceipt.id : cancellationReceipt.id;
  const pendingDuringSaturation = await waitForDispatch(
    owner,
    schedule.trigger.id,
    pendingDispatchId,
    ["pending"],
    10_000,
  );
  guarantees.concurrency_saturation = {
    status: "passed",
    evidence: {
      triggerId: schedule.trigger.id,
      maxConcurrentRuns: 1,
      activeDispatchId: activeDispatch.id,
      pendingDispatchId: pendingDuringSaturation.id,
      stoppedMachines,
    },
  };

  const cancelledRunId = activeDispatch.runId!;
  await readJson(`/workbench/history/runs/${encodeURIComponent(cancelledRunId)}/cancel`, owner, {
    method: "POST",
  });
  const cancelledDispatch = await waitForDispatch(owner, schedule.trigger.id, activeDispatch.id, [
    "cancelled",
  ]);
  await sleep(8_000);
  const cancelledSnapshot = await runSnapshot(owner, cancelledRunId);
  if (
    cancelledSnapshot.snapshot?.run?.status !== "cancelled" ||
    (cancelledSnapshot.snapshot?.artifacts?.length ?? 0) !== 0
  ) {
    throw new Error("cancelled run promoted a late result");
  }
  guarantees.cancellation_authority = {
    status: "passed",
    evidence: {
      dispatchId: cancelledDispatch.id,
      runId: cancelledRunId,
      status: cancelledSnapshot.snapshot?.run?.status,
      artifactsAfterLateCompletion: cancelledSnapshot.snapshot?.artifacts?.length ?? 0,
    },
  };

  await waitForDispatch(
    owner,
    schedule.trigger.id,
    pendingDuringSaturation.id,
    ["completed"],
    pollTimeoutMs,
  );
  await readJson(`/trigger-dispatches/${encodeURIComponent(cancelledDispatch.id)}/replay`, owner, {
    method: "POST",
  });
  const replayedCancellation = await waitForDispatch(
    owner,
    schedule.trigger.id,
    cancelledDispatch.id,
    ["completed"],
  );
  if (
    replayedCancellation.attemptCount !== 2 ||
    replayedCancellation.previousRunId !== cancelledRunId ||
    !replayedCancellation.runId
  ) {
    throw new Error("cancelled dispatch replay did not preserve lineage");
  }
  const replayedCancellationSnapshot = await runSnapshot(owner, replayedCancellation.runId);
  if (
    replayedCancellationSnapshot.snapshot?.run?.data?.retryOfRunId !== cancelledRunId ||
    (replayedCancellationSnapshot.snapshot?.artifacts?.length ?? 0) === 0
  ) {
    throw new Error("replayed cancellation did not publish linked evidence");
  }
  guarantees.cancelled_replay_lineage = {
    status: "passed",
    evidence: {
      dispatchId: cancelledDispatch.id,
      previousRunId: cancelledRunId,
      replayedRunId: replayedCancellation.runId,
      artifactIds: replayedCancellationSnapshot.snapshot?.artifacts?.map((item) => item.id) ?? [],
    },
  };

  const expiredDispatchId = `cf-dispatch-hosted-lease-${suffix}`;
  const expiredRunId = `cf-run-hosted-lease-${suffix}`;
  const expiredIntentId = `cf-intent-hosted-lease-${suffix}`;
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  const createdAt = new Date().toISOString();
  await d1Execute(`
    INSERT INTO control_workflow_intents (
      id, user_id, workspace_id, agent_id, stage, type, execution_json, payload_json,
      status, created_at, updated_at
    ) VALUES (
      ${safeSql(expiredIntentId)}, ${safeSql(owner.userId)}, ${safeSql(workspaceId)},
      ${safeSql(owner.agentId)}, 'execute', 'repo.readiness_report',
      '{"mode":"dry_run"}', '{"input":{}}', 'running', ${safeSql(createdAt)}, ${safeSql(createdAt)}
    );
    INSERT INTO control_runs (
      id, user_id, workspace_id, agent_id, workflow_intent_id, status, execution_json,
      stage, engine, heartbeat_at, last_event_at, data_json, created_at, updated_at
    ) VALUES (
      ${safeSql(expiredRunId)}, ${safeSql(owner.userId)}, ${safeSql(workspaceId)},
      ${safeSql(owner.agentId)}, ${safeSql(expiredIntentId)}, 'running',
      '{"mode":"dry_run"}', 'execute', 'cloudflare', ${safeSql(expiredAt)},
      ${safeSql(expiredAt)}, '{"hostedDrill":"lease_expiry"}',
      ${safeSql(createdAt)}, ${safeSql(createdAt)}
    );
    INSERT INTO control_trigger_dispatches (
      id, trigger_id, user_id, workspace_id, agent_id, idempotency_key, source, status,
      attempt_count, run_id, received_at, lease_owner, lease_expires_at, heartbeat_at,
      payload_json, error_json, created_at, updated_at
    ) VALUES (
      ${safeSql(expiredDispatchId)}, ${safeSql(schedule.trigger.id)}, ${safeSql(owner.userId)},
      ${safeSql(workspaceId)}, ${safeSql(owner.agentId)}, ${safeSql(`hosted-lease-${suffix}`)},
      'manual', 'running', 1, ${safeSql(expiredRunId)}, ${safeSql(createdAt)},
      ${safeSql(`hosted-lease-owner-${suffix}`)}, ${safeSql(expiredAt)}, ${safeSql(expiredAt)},
      '{}', '{}', ${safeSql(createdAt)}, ${safeSql(createdAt)}
    );
  `);
  const recoveredDispatch = await waitForDispatch(
    owner,
    schedule.trigger.id,
    expiredDispatchId,
    ["failed"],
    120_000,
  );
  if (recoveredDispatch.error?.code !== "lease_expired") {
    throw new Error("expired dispatch did not retain lease_expired evidence");
  }
  const expiredRunSnapshot = await runSnapshot(owner, expiredRunId);
  if (expiredRunSnapshot.snapshot?.run?.status !== "failed") {
    throw new Error("lease recovery did not fail the linked run");
  }
  const leaseAlert = await poll("lease expiry operator alert", async () => {
    const body = await readJson<{ alerts?: OperatorAlert[] }>(
      "/admin/operator-alerts?limit=100",
      owner,
    );
    return body.alerts?.find(
      (alert) => alert.code === "lease_expired" && alert.targetId === expiredDispatchId,
    );
  });
  guarantees.lease_expiry_recovery = {
    status: "passed",
    evidence: {
      dispatchId: expiredDispatchId,
      runId: expiredRunId,
      dispatchStatus: recoveredDispatch.status,
      runStatus: expiredRunSnapshot.snapshot?.run?.status,
      alertId: leaseAlert.id,
      alertStatus: leaseAlert.status,
      alertDeliveryStatus: leaseAlert.deliveryStatus,
    },
  };

  await readJson(`/trigger-dispatches/${encodeURIComponent(expiredDispatchId)}/replay`, owner, {
    method: "POST",
  });
  const recoveredReplay = await waitForDispatch(owner, schedule.trigger.id, expiredDispatchId, [
    "completed",
  ]);
  if (
    recoveredReplay.previousRunId !== expiredRunId ||
    !recoveredReplay.runId ||
    recoveredReplay.runId === expiredRunId
  ) {
    throw new Error("lease-expired replay did not create a new linked run");
  }
  const recoveredReplaySnapshot = await runSnapshot(owner, recoveredReplay.runId);
  if (
    recoveredReplaySnapshot.snapshot?.run?.data?.retryOfRunId !== expiredRunId ||
    (recoveredReplaySnapshot.snapshot?.artifacts?.length ?? 0) === 0
  ) {
    throw new Error("lease-expired replay did not complete with linked artifacts");
  }
  guarantees.lease_replay_lineage = {
    status: "passed",
    evidence: {
      dispatchId: expiredDispatchId,
      failedRunId: expiredRunId,
      replayedRunId: recoveredReplay.runId,
      attemptCount: recoveredReplay.attemptCount,
      artifactIds: recoveredReplaySnapshot.snapshot?.artifacts?.map((item) => item.id) ?? [],
    },
  };

  const outputDirectory = resolve("output", "release", commit);
  const outputPath = resolve(outputDirectory, "hosted-level3-drills.json");
  const report = {
    version: 1,
    target: requestedTarget,
    commit,
    generatedAt: new Date().toISOString(),
    startedAt,
    topology: {
      webOrigin,
      cloudflareOrigin: baseUrl,
      flyAppName,
    },
    tenant: {
      userId: owner.userId,
      workspaceId,
      agentId: owner.agentId,
      nonCustomer: true,
    },
    ok: true,
    guarantees,
    limitations: [
      "The alert receiver outage/redelivery drill is retained as separate evidence.",
      "The synthetic expired lease is injected directly into the non-customer D1 tenant.",
    ],
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(
    JSON.stringify({ ok: true, outputPath, guarantees: Object.keys(guarantees) }, null, 2),
  );
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
