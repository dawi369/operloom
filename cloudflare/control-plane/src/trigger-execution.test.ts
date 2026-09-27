import { describe, expect, it } from "vitest";

import {
  executeLeasedTriggerDispatch,
  leasePendingTriggerDispatches,
  type LeasedTriggerDispatch,
} from "./trigger-execution";
import type {
  ControlTriggerDispatchRow,
  ControlTriggerRow,
  D1PreparedStatement,
  Env,
} from "./types";

const trigger: ControlTriggerRow = {
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
  execution_json: '{"mode":"dry_run"}',
  config_json: '{"cron":"0 9 * * 1","timezone":"UTC"}',
  input_json: '{"includeDocs":true}',
  max_concurrent_runs: 1,
  version: 1,
  next_trigger_at: "2026-07-13T09:00:00.000Z",
  last_triggered_at: null,
  created_by_user_id: "user-1",
  created_at: "2026-07-12T00:00:00.000Z",
  updated_at: "2026-07-12T00:00:00.000Z",
};

const dispatch: ControlTriggerDispatchRow = {
  id: "dispatch-1",
  trigger_id: "trigger-1",
  user_id: "user-1",
  workspace_id: "workspace-1",
  agent_id: "agent-1",
  idempotency_key: "schedule:trigger-1:2026-07-12T09:00:00.000Z",
  source: "schedule",
  status: "leased",
  attempt_count: 1,
  run_id: null,
  previous_run_id: null,
  scheduled_for: "2026-07-12T09:00:00.000Z",
  received_at: "2026-07-12T09:00:00.000Z",
  lease_owner: "scheduler-1",
  lease_expires_at: "2026-07-12T09:02:00.000Z",
  heartbeat_at: "2026-07-12T09:00:00.000Z",
  payload_json: "{}",
  error_json: "{}",
  created_at: "2026-07-12T09:00:00.000Z",
  updated_at: "2026-07-12T09:00:00.000Z",
};

const makeEnv = (changes = 1) => {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const batches: Array<Array<{ query: string; values: unknown[] }>> = [];
  const env = {
    DB: {
      prepare(query: string): D1PreparedStatement {
        const call = { query, values: [] as unknown[] };
        calls.push(call);
        return {
          bind(...values: unknown[]) {
            call.values = values;
            return this;
          },
          async first<T>() {
            if (query.includes("FROM control_trigger_dispatches")) return dispatch as T;
            if (query.includes("FROM control_triggers")) return trigger as T;
            return null;
          },
          async all<T>() {
            return { results: [{ id: dispatch.id }] as T[] };
          },
          async run() {
            return { success: true, meta: { changes } };
          },
        };
      },
      async batch(statements: D1PreparedStatement[]) {
        const batchCalls = calls.slice(-statements.length);
        batches.push(batchCalls);
        return statements.map(() => ({ success: true, meta: { changes } }));
      },
    },
  } satisfies Pick<Env, "DB">;
  return { env: env as Env, calls, batches };
};

describe("trigger dispatch execution", () => {
  it("leases pending work only within trigger and agent concurrency limits", async () => {
    const { env, calls } = makeEnv();
    const leased = await leasePendingTriggerDispatches(env, {
      leaseOwner: "scheduler-1",
      now: new Date("2026-07-12T09:00:00.000Z"),
    });

    expect(leased).toHaveLength(1);
    const update = calls.find((call) => call.query.includes("SET status = 'leased'"));
    expect(update?.query).toContain("active.status IN ('leased', 'running')");
    expect(update?.query).toContain("r.status IN ('queued', 'running', 'waiting', 'interrupted')");
  });

  it("leaves saturated dispatches pending", async () => {
    const { env } = makeEnv(0);
    await expect(
      leasePendingTriggerDispatches(env, { leaseOwner: "scheduler-1" }),
    ).resolves.toEqual([]);
  });

  it("fails a leased dispatch when the callback boundary is not configured", async () => {
    const { env, batches } = makeEnv();
    const result = await executeLeasedTriggerDispatch(env, {
      trigger,
      dispatch,
    } satisfies LeasedTriggerDispatch);

    expect(result).toEqual({ ok: false, code: "trigger_callback_unavailable" });
    expect(batches[0]?.map((call) => call.query)).toEqual([
      expect.stringContaining("SET status = 'failed'"),
      expect.stringContaining("INSERT INTO control_audit_events"),
      expect.stringContaining("INSERT OR IGNORE INTO control_operator_alerts"),
    ]);
    expect(batches[0]?.[0]?.query).toContain("lease_owner = ? AND attempt_count = ?");
    expect(batches[0]?.[0]?.values[0]).toContain("trigger_callback_unavailable");
    expect(batches[0]?.[0]?.values.slice(-2)).toEqual(["scheduler-1", 1]);
  });

  it("keeps scheduler bookkeeping out of request-mode monitor workflow input", async () => {
    const { env, batches } = makeEnv();
    env.OPERLOOM_CALLBACK_URL = "http://127.0.0.1:8787";
    const result = await executeLeasedTriggerDispatch(env, {
      trigger: {
        ...trigger,
        pack_id: "resource-allocator",
        pack_trigger_id: "cycle",
        kind: "monitor",
        workflow_type: "resource-allocator.cycle",
        config_json: '{"intervalSeconds":60}',
        input_json: "{}",
      },
      dispatch: { ...dispatch, source: "monitor", payload_json: '{"skippedOccurrences":0}' },
    } satisfies LeasedTriggerDispatch);

    expect(result).not.toMatchObject({ code: "trigger_input_invalid" });
    expect(JSON.stringify(batches)).not.toContain("trigger_input_invalid");
  });
});
