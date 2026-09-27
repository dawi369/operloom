import { describe, expect, it } from "vitest";

import { finishPackWorkflowRun, startPackWorkflowRun } from "./runtime-run-lifecycle";
import type { AgentIdentity, D1PreparedStatement, D1Result, Env } from "./types";

const identity = {
  scope: { userId: "user-1", workspaceId: "workspace-1" },
  agentId: "agent-1",
} satisfies AgentIdentity;

const makeEnv = (runChanges = 1, dispatchChanges = 1) => {
  const batches: Array<Array<{ query: string; values: unknown[] }>> = [];
  const prepared = new Map<D1PreparedStatement, { query: string; values: unknown[] }>();
  const env = {
    DB: {
      prepare(query: string) {
        const captured = { query, values: [] as unknown[] };
        const statement: D1PreparedStatement = {
          bind(...values: unknown[]) {
            captured.values = values;
            return statement;
          },
          async first<T>() {
            return null as T | null;
          },
          async all<T>() {
            return { results: [] as T[] };
          },
          async run() {
            return { success: true, meta: { changes: 1 } };
          },
        };
        prepared.set(statement, captured);
        return statement;
      },
      async batch(statements: D1PreparedStatement[]) {
        batches.push(statements.map((statement) => prepared.get(statement)!));
        return statements.map((statement) => ({
          success: true,
          meta: {
            changes: prepared.get(statement)?.query.includes("UPDATE control_runs")
              ? runChanges
              : prepared.get(statement)?.query.includes("UPDATE control_trigger_dispatches")
                ? dispatchChanges
                : 1,
          },
        })) satisfies D1Result[];
      },
    },
  } satisfies Partial<Env>;
  return { env: env as Env, batches };
};

describe("pack workflow lifecycle", () => {
  it("atomically starts the intent, run, audit, and terminal event lineage", async () => {
    const { env, batches } = makeEnv();
    await startPackWorkflowRun(env, identity, {
      workflowType: "repo.readiness_report",
      policyReference: "repo.snapshot.v1",
      displayName: "Readiness report",
      packId: "repo-analyst",
      toolInput: {},
      executionMode: "dry_run",
      engine: "cloudflare",
    });

    expect(batches).toHaveLength(1);
    expect(batches[0].map(({ query }) => query)).toEqual([
      expect.stringContaining("INSERT INTO control_workflow_intents"),
      expect.stringContaining("INSERT INTO control_runs"),
      expect.stringContaining("INSERT INTO control_audit_events"),
      expect.stringContaining("INSERT INTO control_plane_events"),
    ]);
  });

  it("atomically claims a leased trigger dispatch and records trigger retry lineage", async () => {
    const { env, batches } = makeEnv();
    await startPackWorkflowRun(env, identity, {
      workflowType: "repo.readiness_report",
      policyReference: "repo.snapshot.v1",
      displayName: "Triggered readiness report",
      packId: "repo-analyst",
      toolInput: { depth: 2 },
      executionMode: "dry_run",
      engine: "cloudflare",
      invocation: {
        source: "trigger",
        triggerId: "trigger-1",
        packTriggerId: "scheduled-readiness",
        dispatchId: "dispatch-1",
        leaseOwner: "scheduler-1",
        triggerSource: "replay",
        attemptCount: 2,
        idempotencyKey: "tick-1",
        scheduledFor: "2026-06-20T12:00:00.000Z",
        previousRunId: "run-previous",
      },
    });

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(5);
    expect(batches[0][0]).toMatchObject({
      query: expect.stringContaining("status = 'leased' AND lease_owner = ?"),
    });
    expect(batches[0].slice(1).every(({ query }) => query.includes("WHERE EXISTS"))).toBe(true);
    const serializedValues = batches[0]
      .flatMap(({ values }) => values)
      .filter((value): value is string => typeof value === "string");
    expect(serializedValues.some((value) => value.includes('"dispatchId":"dispatch-1"'))).toBe(
      true,
    );
    expect(serializedValues.some((value) => value.includes('"retryOfRunId":"run-previous"'))).toBe(
      true,
    );
  });

  it("creates no unconditional run records after losing the trigger lease", async () => {
    const { env, batches } = makeEnv(1, 0);
    await expect(
      startPackWorkflowRun(env, identity, {
        workflowType: "repo.readiness_report",
        policyReference: "repo.snapshot.v1",
        displayName: "Stale trigger",
        packId: "repo-analyst",
        toolInput: {},
        executionMode: "dry_run",
        engine: "cloudflare",
        invocation: {
          source: "trigger",
          triggerId: "trigger-1",
          packTriggerId: "scheduled-readiness",
          dispatchId: "dispatch-stale",
          leaseOwner: "stale-owner",
          triggerSource: "schedule",
          attemptCount: 1,
          idempotencyKey: "tick-stale",
          scheduledFor: null,
          previousRunId: null,
        },
      }),
    ).rejects.toThrow("trigger_dispatch_lease_lost");

    expect(batches).toHaveLength(1);
    expect(
      batches[0]
        .filter(({ query }) => query.includes("INSERT INTO control_"))
        .every(({ query }) => query.includes("EXISTS")),
    ).toBe(true);
  });

  it("discards final output when the run loses the active-state compare-and-set", async () => {
    const { env, batches } = makeEnv(0);
    const result = await finishPackWorkflowRun(env, identity, {
      runId: "run-1",
      workflowIntentId: "intent-1",
      relation: { kind: "root", rootRunId: "run-1", depth: 0, durableChild: false },
      workflowType: "repo.readiness_report",
      ok: true,
      summary: "late output",
      artifact: {
        id: "artifact-1",
        kind: "repo_snapshot_report",
        uri: "d1://artifact-1",
        title: "Late artifact",
        mimeType: "application/json",
        sizeBytes: 1,
        data: {},
      },
      data: {},
    });

    expect(result).toEqual({ applied: false });
    expect(batches).toHaveLength(1);
    expect(batches[0].find(({ query }) => query.includes("UPDATE control_runs"))?.query).toContain(
      "json_patch(data_json",
    );
    expect(
      batches[0]
        .filter(
          ({ query }) => query.includes("control_artifacts") || query.includes("control_audit"),
        )
        .every(({ query }) => query.includes("EXISTS")),
    ).toBe(true);
  });
});
