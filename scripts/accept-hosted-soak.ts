import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createSmokeContext, defaultWorkspaceId, sleep, type TenantIdentity } from "./smoke-utils";
import { renderEnvironmentConfig } from "./render-environment-config";

type Trigger = { id: string; publicId?: string; version?: number };
type Dispatch = {
  id: string;
  status: string;
  source: string;
  runId?: string;
  scheduledFor?: string;
};
type SoakState = {
  schemaVersion: 1;
  target: "acceptance";
  commit: string;
  startedAt: string;
  owner: TenantIdentity;
  scheduleTriggerId: string;
  initialWebhookTriggerId: string;
  initialWebhookDispatchId: string;
};

const valueAfter = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const phase = valueAfter("--phase");
const commit = process.env.GITHUB_SHA?.trim() ?? "";
if (process.env.WORKBENCH_HOSTED_SOAK_MODE !== "true") {
  throw new Error("WORKBENCH_HOSTED_SOAK_MODE=true is required");
}
if (process.env.WORKBENCH_ENVIRONMENT !== "acceptance") {
  throw new Error("The elapsed soak is acceptance-only");
}
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("GITHUB_SHA must be a full commit");
if (phase !== "start" && phase !== "finish") throw new Error("--phase must be start|finish");

const rendered = renderEnvironmentConfig("acceptance");
const webOrigin = process.env.HOSTED_WEB_ORIGIN?.trim().replace(/\/$/, "");
if (!webOrigin) throw new Error("HOSTED_WEB_ORIGIN is required");
const { readJson } = createSmokeContext({ pollTimeoutDefault: 180_000 });
const safeSql = (value: string) => `'${value.replaceAll("'", "''")}'`;
const d1Execute = (sql: string) => {
  execFileSync(
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
    {
      cwd: process.cwd(),
      env: { ...process.env, CI: "true", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
};
const pollDispatch = async (identity: TenantIdentity, triggerId: string, dispatchId: string) => {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const body = await readJson<{ dispatches?: Dispatch[] }>(
      `/trigger-dispatches?triggerId=${encodeURIComponent(triggerId)}&limit=100`,
      identity,
    );
    const dispatch = body.dispatches?.find((candidate) => candidate.id === dispatchId);
    if (dispatch?.status === "completed") return dispatch;
    if (dispatch && ["failed", "cancelled"].includes(dispatch.status)) {
      throw new Error(`soak dispatch ${dispatchId} ended ${dispatch.status}`);
    }
    await sleep(1_000);
  }
  throw new Error(`soak dispatch ${dispatchId} did not complete`);
};
const createTrigger = async (
  identity: TenantIdentity,
  packTriggerId: "scheduled-readiness" | "readiness-requested",
) => {
  const body = await readJson<{ trigger?: Trigger; webhookSecret?: string }>(
    "/triggers",
    identity,
    {
      method: "POST",
      body: JSON.stringify({ packId: "repo-analyst", packTriggerId, status: "enabled" }),
    },
  );
  if (!body.trigger) throw new Error(`${packTriggerId} trigger was not created`);
  return { trigger: body.trigger, webhookSecret: body.webhookSecret };
};
const sendWebhook = async (trigger: Trigger, secret: string, idempotencyKey: string) => {
  if (!trigger.publicId) throw new Error("Webhook public ID is missing");
  const request = () =>
    fetch(`${webOrigin}/api/external-signals/${encodeURIComponent(trigger.publicId!)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ includeDocs: true, includeScripts: true, includeConfig: true }),
    });
  const first = await request();
  if (first.status !== 202) throw new Error(`soak webhook returned ${first.status}`);
  const firstBody = (await first.json()) as { dispatchId?: string };
  if (!firstBody.dispatchId) throw new Error("soak webhook dispatch ID is missing");
  const duplicate = await request();
  const duplicateBody = (await duplicate.json()) as { duplicate?: boolean; dispatchId?: string };
  if (
    duplicate.status !== 200 ||
    duplicateBody.duplicate !== true ||
    duplicateBody.dispatchId !== firstBody.dispatchId
  ) {
    throw new Error("soak webhook duplicate was not deduplicated");
  }
  return firstBody.dispatchId;
};

const start = async () => {
  const suffix = `${commit.slice(0, 8)}-${Date.now().toString(36)}`;
  const accountId = `workos-org:soak-${suffix}`;
  const owner: TenantIdentity = {
    userId: `soak-owner-${suffix}`,
    accountId,
    accountSource: "workos-organization",
    workspaceId: defaultWorkspaceId(accountId),
    email: `soak-${suffix}@example.com`,
    name: "24 Hour Soak Acceptance",
    role: "owner",
    roles: ["owner"],
    permissions: ["workbench:read"],
    authMode: "workos",
    workspaceSource: "workos-organization",
  };
  await readJson("/admin/workspace-summary", owner);
  const pack = await readJson<{ agent?: { id?: string } }>(
    "/agent-packs/repo-analyst/instantiate",
    owner,
    { method: "POST" },
  );
  if (!pack.agent?.id) throw new Error("Repository Analyst activation failed");
  owner.agentId = pack.agent.id;
  await readJson(`/agents/${encodeURIComponent(owner.agentId)}/activate`, owner, {
    method: "POST",
  });
  const webhook = await createTrigger(owner, "readiness-requested");
  if (!webhook.webhookSecret) throw new Error("Initial webhook secret is missing");
  const initialWebhookDispatchId = await sendWebhook(
    webhook.trigger,
    webhook.webhookSecret,
    `soak-start-${suffix}`,
  );
  await pollDispatch(owner, webhook.trigger.id, initialWebhookDispatchId);
  const schedule = await createTrigger(owner, "scheduled-readiness");
  const now = new Date().toISOString();
  d1Execute(`UPDATE control_triggers
    SET config_json = '{"cron":"*/30 * * * *","timezone":"UTC"}',
        next_trigger_at = ${safeSql(now)}, updated_at = ${safeSql(now)}, version = version + 1
    WHERE id = ${safeSql(schedule.trigger.id)} AND workspace_id = ${safeSql(owner.workspaceId ?? "")}`);
  const state: SoakState = {
    schemaVersion: 1,
    target: "acceptance",
    commit,
    startedAt: new Date().toISOString(),
    owner,
    scheduleTriggerId: schedule.trigger.id,
    initialWebhookTriggerId: webhook.trigger.id,
    initialWebhookDispatchId,
  };
  const directory = resolve(process.cwd(), "output/release", commit);
  mkdirSync(directory, { recursive: true });
  const statePath = resolve(directory, "soak-24h-state.json");
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, statePath, startedAt: state.startedAt }, null, 2));
};

const finish = async () => {
  const statePath = valueAfter("--state");
  if (!statePath || !existsSync(statePath))
    throw new Error("--state must name the start-state JSON");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as SoakState;
  if (
    state.schemaVersion !== 1 ||
    state.target !== "acceptance" ||
    state.commit !== commit ||
    !Number.isFinite(Date.parse(state.startedAt))
  ) {
    throw new Error("Soak state must match the acceptance target and full commit");
  }
  const elapsedMs = Date.now() - Date.parse(state.startedAt);
  if (elapsedMs < 24 * 60 * 60 * 1_000) throw new Error("24 elapsed hours have not passed");
  const scheduleBody = await readJson<{ dispatches?: Dispatch[] }>(
    `/trigger-dispatches?triggerId=${encodeURIComponent(state.scheduleTriggerId)}&limit=100`,
    state.owner,
  );
  const scheduled = (scheduleBody.dispatches ?? []).filter(
    (dispatch) => dispatch.source === "schedule" && dispatch.status === "completed",
  );
  if (scheduled.length < 40) {
    throw new Error(`24-hour schedule soak completed only ${scheduled.length} dispatches; need 40`);
  }
  const finalWebhook = await createTrigger(state.owner, "readiness-requested");
  if (!finalWebhook.webhookSecret) throw new Error("Final webhook secret is missing");
  const finalWebhookDispatchId = await sendWebhook(
    finalWebhook.trigger,
    finalWebhook.webhookSecret,
    `soak-finish-${commit.slice(0, 12)}`,
  );
  await pollDispatch(state.owner, finalWebhook.trigger.id, finalWebhookDispatchId);
  const currentSchedule = await readJson<{ trigger?: Trigger }>(
    `/triggers/${encodeURIComponent(state.scheduleTriggerId)}`,
    state.owner,
  );
  if (!currentSchedule.trigger?.version) throw new Error("Soak schedule version is missing");
  await readJson(`/triggers/${encodeURIComponent(state.scheduleTriggerId)}`, state.owner, {
    method: "PATCH",
    body: JSON.stringify({ status: "paused", expectedVersion: currentSchedule.trigger.version }),
  });
  const completedAt = new Date().toISOString();
  const report = {
    schemaVersion: 1,
    target: "acceptance",
    commit,
    status: "passed",
    startedAt: state.startedAt,
    completedAt,
    operator: process.env.WORKBENCH_RELEASE_OPERATOR?.trim() || process.env.USER || "unknown",
    artifactPaths: [],
    identifiers: {
      workspaceId: state.owner.workspaceId,
      scheduleTriggerId: state.scheduleTriggerId,
      initialWebhookDispatchId: state.initialWebhookDispatchId,
      finalWebhookDispatchId,
    },
    evidence: {
      elapsedMs,
      completedScheduledDispatches: scheduled.length,
      firstScheduledFor: scheduled.at(-1)?.scheduledFor,
      lastScheduledFor: scheduled[0]?.scheduledFor,
      webhookHealthyAtStartAndFinish: true,
      duplicateWebhookDeduplication: true,
    },
  };
  const outputPath = resolve(process.cwd(), "output/release", commit, "soak-24h.json");
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, outputPath, elapsedMs }, null, 2));
};

void (phase === "start" ? start() : finish()).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
