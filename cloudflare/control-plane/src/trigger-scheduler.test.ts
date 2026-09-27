import { describe, expect, it } from "vitest";

import { dispatchDueTriggers } from "./trigger-scheduler";
import type { ControlTriggerRow, D1PreparedStatement, D1Result, Env } from "./types";

const dueTrigger: ControlTriggerRow = {
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
  input_json: "{}",
  max_concurrent_runs: 1,
  version: 1,
  next_trigger_at: "2026-07-06T09:00:00.000Z",
  last_triggered_at: null,
  created_by_user_id: "user-1",
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

describe("trigger scheduler", () => {
  it("coalesces a due trigger and atomically inserts one idempotent dispatch", async () => {
    const batches: Array<Array<{ query: string; values: unknown[] }>> = [];
    const prepared = new Map<D1PreparedStatement, { query: string; values: unknown[] }>();
    const env = {
      DB: {
        prepare(query: string): D1PreparedStatement {
          const record = { query, values: [] as unknown[] };
          const statement: D1PreparedStatement = {
            bind(...values: unknown[]) {
              record.values = values;
              return statement;
            },
            async first<T>() {
              return (
                query.startsWith("SELECT id FROM control_trigger_dispatches")
                  ? { id: record.values[0] }
                  : null
              ) as T | null;
            },
            async all<T>() {
              return { results: [dueTrigger] as T[] };
            },
            async run() {
              return { success: true };
            },
          };
          prepared.set(statement, record);
          return statement;
        },
        async batch(statements: D1PreparedStatement[]) {
          batches.push(statements.map((statement) => prepared.get(statement)!));
          return statements.map(() => ({ success: true, meta: { changes: 1 } })) as D1Result[];
        },
      },
    } as Env;

    const result = await dispatchDueTriggers(env, {
      now: new Date("2026-07-12T12:00:00.000Z"),
    });

    expect(result).toEqual({ inspected: 1, created: 1 });
    expect(batches[0]?.[0]?.query).toContain("AND next_trigger_at = ?");
    expect(batches[0]?.[1]?.query).toContain("INSERT OR IGNORE");
    expect(batches[0]?.[1]?.values).toContain("schedule:trigger-1:2026-07-06T09:00:00.000Z");
    expect(batches[0]?.[1]?.values).toContain('{"skippedOccurrences":0}');
  });
});
