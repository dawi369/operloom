import { describe, expect, it } from "vitest";

import { agentBehaviorTemplates, type AgentBehaviorTemplate } from "./agent-behavior-templates";
import {
  handleCreateTrigger,
  handleCreateTriggerDispatch,
  handleGetTrigger,
  handleListTriggers,
  handleReplayTriggerDispatch,
  handleUpdateTrigger,
} from "./triggers";
import type {
  AgentIdentity,
  AgentRow,
  ControlTriggerDispatchRow,
  ControlTriggerRow,
  D1PreparedStatement,
  D1Result,
  Env,
  MembershipRow,
} from "./types";

const identity: AgentIdentity = {
  scope: { userId: "user-1", workspaceId: "workspace-1" },
  agentId: "agent-1",
};

const membership = (role: "owner" | "member" = "owner"): MembershipRow => ({
  id: "membership-1",
  user_id: "user-1",
  workspace_id: "workspace-1",
  role,
  status: "active",
  roles_json: "[]",
  permissions_json: "[]",
  data_json: "{}",
  created_at: "2026-07-12T00:00:00.000Z",
  updated_at: "2026-07-12T00:00:00.000Z",
});

// Forks may hide the upstream Repository Analyst demo pack with conformanceOnly.
const repoTemplate = (agentBehaviorTemplates as readonly AgentBehaviorTemplate[]).find(
  (template) => template.pack?.id === "repo-analyst",
);

const agent: AgentRow = {
  id: "agent-1",
  workspace_id: "workspace-1",
  name: "Repository Analyst",
  description: null,
  status: "active",
  is_default: 0,
  created_by_user_id: "user-1",
  data_json: JSON.stringify({
    profile: "analyst",
    behavior: {
      source: "template-snapshot",
      format: "xml",
      templateId: repoTemplate?.id,
      version: repoTemplate?.version,
      authoring: repoTemplate?.authoring,
      pack: repoTemplate?.pack,
      prompt: repoTemplate?.prompt,
    },
  }),
  created_at: "2026-07-12T00:00:00.000Z",
  updated_at: "2026-07-12T00:00:00.000Z",
};

const triggerRow: ControlTriggerRow = {
  id: "trigger-1",
  public_id: null,
  secret_hash: null,
  user_id: "user-1",
  workspace_id: "workspace-1",
  agent_id: "agent-1",
  pack_id: "repo-analyst",
  pack_trigger_id: "scheduled-readiness",
  kind: "schedule",
  workflow_type: "repo.readiness_report",
  status: "enabled",
  execution_json: '{"mode":"dry_run","policy":"trigger-readonly-v0"}',
  config_json: '{"cron":"0 9 * * 1","timezone":"UTC"}',
  input_json: '{"includeDocs":true,"includeScripts":true,"includeConfig":true}',
  max_concurrent_runs: 1,
  version: 2,
  next_trigger_at: null,
  last_triggered_at: null,
  created_by_user_id: "user-1",
  created_at: "2026-07-12T00:00:00.000Z",
  updated_at: "2026-07-12T00:00:00.000Z",
};

const dispatchRow: ControlTriggerDispatchRow = {
  id: "dispatch-1",
  trigger_id: "trigger-1",
  user_id: "user-1",
  workspace_id: "workspace-1",
  agent_id: "agent-1",
  idempotency_key: "manual:one",
  source: "manual",
  status: "pending",
  attempt_count: 0,
  run_id: null,
  previous_run_id: null,
  scheduled_for: null,
  received_at: "2026-07-12T00:01:00.000Z",
  lease_owner: null,
  lease_expires_at: null,
  heartbeat_at: null,
  payload_json: "{}",
  error_json: "{}",
  created_at: "2026-07-12T00:01:00.000Z",
  updated_at: "2026-07-12T00:01:00.000Z",
};

const makeEnv = (
  options: {
    role?: "owner" | "member";
    agent?: AgentRow | null;
    trigger?: ControlTriggerRow | null;
    dispatch?: ControlTriggerDispatchRow | null;
    writeChanges?: number;
  } = {},
) => {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const makeStatement = (query: string): D1PreparedStatement => {
    const call = { query, values: [] as unknown[] };
    calls.push(call);
    return {
      bind(...values: unknown[]) {
        call.values = values;
        return this;
      },
      async first<T>() {
        if (query.includes("FROM memberships")) return membership(options.role) as T;
        if (query.includes("FROM agents")) {
          return (options.agent === undefined ? agent : options.agent) as T | null;
        }
        if (query.includes("control_trigger_dispatches")) {
          return (options.dispatch === undefined ? dispatchRow : options.dispatch) as T | null;
        }
        if (query.includes("control_triggers")) {
          return (options.trigger === undefined ? triggerRow : options.trigger) as T | null;
        }
        return null;
      },
      async all<T>() {
        if (query.includes("control_trigger_dispatches")) return { results: [dispatchRow] as T[] };
        return { results: [triggerRow] as T[] };
      },
      async run() {
        return { success: true, meta: { changes: options.writeChanges ?? 1 } };
      },
    };
  };
  const env = {
    DB: {
      prepare: makeStatement,
      async batch(statements: D1PreparedStatement[]) {
        return statements.map(() => ({
          success: true,
          meta: { changes: options.writeChanges ?? 1 },
        })) as D1Result[];
      },
    },
  } satisfies Pick<Env, "DB">;
  return { env: env as Env, calls };
};

describe.runIf(repoTemplate?.pack)("trigger control foundation", () => {
  it("allows active members to list only the current tenant and agent scope", async () => {
    const { env, calls } = makeEnv({ role: "member" });
    const response = await handleListTriggers(
      env,
      identity,
      new URL("https://worker.test/triggers"),
    );
    expect(response.status).toBe(200);
    expect(calls.at(-1)?.values).toEqual(["user-1", "workspace-1", "agent-1", 50]);
  });

  it("returns 404 for a trigger outside the trusted scope", async () => {
    const { env, calls } = makeEnv({ role: "member", trigger: null });
    const response = await handleGetTrigger(env, identity, "other-trigger");
    expect(response.status).toBe(404);
    expect(calls.at(-1)?.values).toEqual(["user-1", "workspace-1", "agent-1", "other-trigger"]);
  });

  it("requires an admin for trigger creation", async () => {
    const { env } = makeEnv({ role: "member" });
    const response = await handleCreateTrigger(
      new Request("https://worker.test/triggers", {
        method: "POST",
        body: JSON.stringify({ packId: "repo-analyst", packTriggerId: "scheduled-readiness" }),
      }),
      env,
      identity,
    );
    expect(response.status).toBe(403);
  });

  it("creates only the checked-in active pack trigger with dry-run execution", async () => {
    const { env, calls } = makeEnv();
    const response = await handleCreateTrigger(
      new Request("https://worker.test/triggers", {
        method: "POST",
        body: JSON.stringify({
          packId: "repo-analyst",
          packTriggerId: "scheduled-readiness",
          status: "paused",
          input: { includeDocs: true },
        }),
      }),
      env,
      identity,
    );
    expect(response.status).toBe(201);
    const insert = calls.find((call) =>
      call.query.includes("INSERT OR IGNORE INTO control_triggers"),
    );
    expect(insert?.values).toContain('{"mode":"dry_run","policy":"trigger-readonly-v0"}');
    expect(insert?.values).toContain('{"cron":"0 9 * * 1","timezone":"UTC"}');
  });

  it("returns a webhook secret once and persists only its hash", async () => {
    const { env, calls } = makeEnv();
    const response = await handleCreateTrigger(
      new Request("https://worker.test/triggers", {
        method: "POST",
        body: JSON.stringify({
          packId: "repo-analyst",
          packTriggerId: "readiness-requested",
          status: "paused",
        }),
      }),
      env,
      identity,
    );
    const body = (await response.json()) as { webhookSecret?: string };
    expect(response.status).toBe(201);
    expect(body.webhookSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const insert = calls.find((call) =>
      call.query.includes("INSERT OR IGNORE INTO control_triggers"),
    );
    expect(insert?.values).not.toContain(body.webhookSecret);
    expect(
      insert?.values.some((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)),
    ).toBe(true);
  });

  it("rejects a trigger when the active agent snapshot is not the checked-in pack version", async () => {
    const staleData = JSON.parse(agent.data_json) as {
      behavior: { pack: { version: string } };
    };
    staleData.behavior.pack.version = "0.9.0";
    const { env } = makeEnv({ agent: { ...agent, data_json: JSON.stringify(staleData) } });
    const response = await handleCreateTrigger(
      new Request("https://worker.test/triggers", {
        method: "POST",
        body: JSON.stringify({
          packId: "repo-analyst",
          packTriggerId: "scheduled-readiness",
        }),
      }),
      env,
      identity,
    );
    expect(response.status).toBe(404);
  });

  it("rejects oversized trigger input before persistence", async () => {
    const { env, calls } = makeEnv();
    const response = await handleCreateTrigger(
      new Request("https://worker.test/triggers", {
        method: "POST",
        body: JSON.stringify({
          packId: "repo-analyst",
          packTriggerId: "scheduled-readiness",
          input: { note: "x".repeat(17 * 1024) },
        }),
      }),
      env,
      identity,
    );
    expect(response.status).toBe(413);
    expect(
      calls.some((call) => call.query.includes("INSERT OR IGNORE INTO control_triggers")),
    ).toBe(false);
  });

  it("treats disabled as a terminal trigger state", async () => {
    const { env } = makeEnv({ trigger: { ...triggerRow, status: "disabled" } });
    const response = await handleUpdateTrigger(
      new Request("https://worker.test/triggers/trigger-1", {
        method: "PATCH",
        body: JSON.stringify({ expectedVersion: 2, status: "enabled" }),
      }),
      env,
      identity,
      "trigger-1",
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "Disabled triggers are terminal",
    });
  });

  it("atomically revokes active runs and dispatches when a trigger is disabled", async () => {
    const { env, calls } = makeEnv();
    const response = await handleUpdateTrigger(
      new Request("https://worker.test/triggers/trigger-1", {
        method: "PATCH",
        body: JSON.stringify({ expectedVersion: 2, status: "disabled" }),
      }),
      env,
      identity,
      "trigger-1",
    );

    expect(response.status).toBe(200);
    expect(calls.some((call) => call.query.includes("UPDATE control_runs"))).toBe(true);
    expect(calls.some((call) => call.query.includes("UPDATE control_workflow_intents"))).toBe(true);
    const dispatchCancel = calls.find(
      (call) =>
        call.query.includes("UPDATE control_trigger_dispatches") &&
        call.query.includes("status = 'cancelled'"),
    );
    expect(dispatchCancel?.query).toContain("status IN ('pending', 'leased', 'running')");
  });

  it("deduplicates dispatch receipt by trigger and idempotency key", async () => {
    const { env, calls } = makeEnv({ writeChanges: 0 });
    const response = await handleCreateTriggerDispatch(
      new Request("https://worker.test/triggers/trigger-1/dispatches", {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: "manual:one", payload: {} }),
      }),
      env,
      identity,
      "trigger-1",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ created: false, duplicate: true });
    const insert = calls.find((call) =>
      call.query.includes("INSERT OR IGNORE INTO control_trigger_dispatches"),
    );
    expect(insert?.query).toContain("status = 'enabled'");
    expect(insert?.values.slice(-4)).toEqual(["trigger-1", "user-1", "workspace-1", "agent-1"]);
  });

  it("replays a failed dispatch as a leased linked attempt", async () => {
    const failed = {
      ...dispatchRow,
      status: "failed" as const,
      attempt_count: 1,
      run_id: "run-failed",
    };
    const { env, calls } = makeEnv({ dispatch: failed });
    const response = await handleReplayTriggerDispatch(env, identity, failed.id);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      dispatch: {
        id: failed.id,
        status: "leased",
        attemptCount: 2,
        previousRunId: "run-failed",
      },
    });
    const replay = calls.find((call) => call.query.includes("previous_run_id = run_id"));
    expect(replay?.query).toContain("status IN ('failed', 'cancelled')");
    expect(replay?.query).toContain("active.status IN ('leased', 'running')");
  });
});
