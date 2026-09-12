import { json } from "./http";
import type { AgentIdentity, Env } from "./types";

const enabled = (value: string | undefined) => value?.trim().toLowerCase() === "true";
const requiredPackIds = ["operloom", "repo-analyst", "baby-polymancer"] as const;

const positiveInteger = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export const demoModeEnabled = (env: Env) => enabled(env.WORKBENCH_DEMO_MODE);

export const resolveDemoPolicy = (env: Env) => {
  if (!demoModeEnabled(env)) return null;
  let allowlist: string[] = [];
  try {
    const parsed = JSON.parse(env.WORKBENCH_DEMO_PACK_ALLOWLIST ?? "");
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
      allowlist = parsed;
    }
  } catch {
    // Invalid public-demo configuration is handled by the fail-closed result below.
  }
  const chatDailyLimit = positiveInteger(env.WORKBENCH_DEMO_CHAT_DAILY_LIMIT);
  const workflowDailyLimit = positiveInteger(env.WORKBENCH_DEMO_WORKFLOW_DAILY_LIMIT);
  const modelBudgetUsd = Number(env.WORKBENCH_DEMO_MODEL_BUDGET_USD);
  const artifactWorkspaceBytes = positiveInteger(env.WORKBENCH_DEMO_ARTIFACT_WORKSPACE_BYTES);
  const retentionDays = positiveInteger(env.WORKBENCH_DEMO_RETENTION_DAYS);
  const valid =
    requiredPackIds.every((packId) => allowlist.includes(packId)) &&
    allowlist.length === requiredPackIds.length &&
    chatDailyLimit === 20 &&
    workflowDailyLimit === 3 &&
    modelBudgetUsd === 20 &&
    artifactWorkspaceBytes === 20 * 1024 * 1024 &&
    retentionDays === 7;
  return {
    valid,
    allowlist: new Set(allowlist),
    chatDailyLimit: chatDailyLimit ?? 0,
    workflowDailyLimit: workflowDailyLimit ?? 0,
    modelBudgetUsd: Number.isFinite(modelBudgetUsd) ? modelBudgetUsd : 0,
    artifactWorkspaceBytes: artifactWorkspaceBytes ?? 0,
    retentionDays: retentionDays ?? 0,
  };
};

export const demoConfigurationValid = (env: Env) => resolveDemoPolicy(env)?.valid ?? true;

export const demoPackAllowed = (env: Env, packId: string | undefined) => {
  const policy = resolveDemoPolicy(env);
  return !policy || (policy.valid && Boolean(packId && policy.allowlist.has(packId)));
};

export const ensureDemoRetentionPolicy = async (env: Env, identity: AgentIdentity) => {
  const policy = resolveDemoPolicy(env);
  if (!policy?.valid) return;
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO control_retention_policies (
       user_id, workspace_id, artifact_retention_days, operational_event_retention_days,
       runtime_trace_retention_days, chat_message_retention_days, run_payload_retention_days,
       audit_action_retention_days, confirmed_at, confirmed_by_user_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 365, ?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       artifact_retention_days = excluded.artifact_retention_days,
       operational_event_retention_days = excluded.operational_event_retention_days,
       runtime_trace_retention_days = excluded.runtime_trace_retention_days,
       chat_message_retention_days = excluded.chat_message_retention_days,
       run_payload_retention_days = excluded.run_payload_retention_days,
       confirmed_at = excluded.confirmed_at,
       confirmed_by_user_id = excluded.confirmed_by_user_id,
       updated_at = excluded.updated_at`,
  )
    .bind(
      identity.scope.userId,
      identity.scope.workspaceId,
      policy.retentionDays,
      policy.retentionDays,
      policy.retentionDays,
      policy.retentionDays,
      policy.retentionDays,
      timestamp,
      identity.scope.userId,
      timestamp,
      timestamp,
    )
    .run();
};

export const demoDisabledResponse = (capability: string) =>
  json(
    {
      ok: false,
      code: "demo_capability_disabled",
      error: `${capability} is disabled in the public demo.`,
    },
    { status: 403 },
  );

export const claimDemoDailyUsage = async (
  env: Env,
  identity: AgentIdentity,
  kind: "chat" | "workflow",
) => {
  const policy = resolveDemoPolicy(env);
  if (!policy) return null;
  if (!policy.valid) {
    return json(
      { ok: false, code: "demo_configuration_invalid", error: "The demo is unavailable." },
      { status: 503 },
    );
  }
  const date = new Date().toISOString().slice(0, 10);
  const column = kind === "chat" ? "chat_count" : "workflow_count";
  const limit = kind === "chat" ? policy.chatDailyLimit : policy.workflowDailyLimit;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO control_demo_daily_usage
       (user_id, usage_date, chat_count, workflow_count, updated_at)
     VALUES (?, ?, 0, 0, ?)`,
  )
    .bind(identity.scope.userId, date, new Date().toISOString())
    .run();
  const claimed = await env.DB.prepare(
    `UPDATE control_demo_daily_usage
     SET ${column} = ${column} + 1, updated_at = ?
     WHERE user_id = ? AND usage_date = ? AND ${column} < ?
     RETURNING ${column} AS count`,
  )
    .bind(new Date().toISOString(), identity.scope.userId, date, limit)
    .first<{ count: number }>();
  if (claimed) return null;
  return json(
    {
      ok: false,
      code: "demo_daily_limit_reached",
      error: `This public demo allows ${limit} ${kind === "chat" ? "chat turns" : "workflow runs"} per user each day.`,
    },
    { status: 429 },
  );
};

export const requireDemoConcurrencyAvailable = async (env: Env, identity: AgentIdentity) => {
  const policy = resolveDemoPolicy(env);
  if (!policy) return null;
  const [chat, workflow] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM chat_runs
       WHERE user_id = ? AND status = 'running'`,
    )
      .bind(identity.scope.userId)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM control_runs
       WHERE user_id = ? AND status IN ('queued', 'running', 'waiting', 'interrupted')`,
    )
      .bind(identity.scope.userId)
      .first<{ count: number }>(),
  ]);
  if ((chat?.count ?? 0) + (workflow?.count ?? 0) === 0) return null;
  return json(
    {
      ok: false,
      code: "demo_concurrency_limit_reached",
      error: "The public demo allows one active run per user.",
    },
    { status: 429 },
  );
};

type OpenRouterKeyStatus = {
  data?: {
    limit?: unknown;
    limit_remaining?: unknown;
    limit_reset?: unknown;
    usage_monthly?: unknown;
  };
};

export const requireDemoModelBudget = async (env: Env) => {
  const policy = resolveDemoPolicy(env);
  if (!policy) return null;
  if (!policy.valid || !env.OPENROUTER_API_KEY) {
    return json(
      { ok: false, code: "demo_configuration_invalid", error: "The demo is unavailable." },
      { status: 503 },
    );
  }
  try {
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
    });
    if (!response.ok) throw new Error(`OpenRouter key status returned ${response.status}`);
    const status = (await response.json()) as OpenRouterKeyStatus;
    const limit = Number(status.data?.limit);
    const remaining = Number(status.data?.limit_remaining);
    const usage = Number(status.data?.usage_monthly);
    if (
      limit !== policy.modelBudgetUsd ||
      status.data?.limit_reset !== "monthly" ||
      !Number.isFinite(remaining) ||
      !Number.isFinite(usage)
    ) {
      throw new Error("OpenRouter demo key does not have the required monthly limit");
    }
    for (const threshold of [50, 75, 90]) {
      if (usage < (limit * threshold) / 100) continue;
      const result = await env.DB.prepare(
        `INSERT OR IGNORE INTO control_demo_budget_alerts
           (usage_month, threshold_percent, usage_usd, created_at)
         VALUES (?, ?, ?, ?)`,
      )
        .bind(new Date().toISOString().slice(0, 7), threshold, usage, new Date().toISOString())
        .run();
      if (((result as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0) {
        console.warn("Operloom demo model budget threshold reached", { threshold, usage, limit });
      }
    }
    if (remaining > 0) return null;
    return json(
      {
        ok: false,
        code: "demo_budget_exhausted",
        error:
          "The public demo has reached its monthly model budget. Existing history is still available.",
      },
      { status: 503 },
    );
  } catch (error) {
    console.error("Unable to verify the Operloom demo model budget", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return json(
      {
        ok: false,
        code: "demo_budget_unavailable",
        error: "Demo capacity cannot be verified right now.",
      },
      { status: 503 },
    );
  }
};

export const demoMutationCapabilityForRequest = (request: Request) => {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return null;
  }
  const path = new URL(request.url).pathname;
  if (path === "/workbench/workspace-deletion" || path === "/workbench/workspace-deletion/retry") {
    return null;
  }
  if (path === "/agents") return "Custom agents";
  if (path.startsWith("/workbench/connections")) return "Connections";
  if (path.startsWith("/workbench/actions") || path.startsWith("/workbench/kill-switches"))
    return "Actions";
  if (path.startsWith("/tools")) return "Direct tool administration";
  if (path.startsWith("/triggers") || path.startsWith("/trigger-dispatches"))
    return "Schedules and webhooks";
  if (path.startsWith("/workbench/devices") || path === "/workbench/notification-preferences")
    return "Notifications";
  if (path === "/workbench/artifacts") return "Direct artifact uploads";
  if (path === "/workbench/retention-policy") return "Retention changes";
  if (path.startsWith("/workbench/managed-state")) return "Managed-state mutations";
  if (/^\/workbench\/history\/runs\/[^/]+\/retry$/.test(path)) return "Workflow retries";
  if (path.startsWith("/admin/")) return "Administrative mutations";
  if (path === "/workspaces" || /^\/workspaces\/[^/]+\/members/.test(path))
    return "Workspace administration";
  return null;
};
