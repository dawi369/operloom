import {
  startDurableWorkflowEngine,
  runDurableWorkflow,
  durableWorkflowDefinitionHash,
} from "./durable-workflow-runtime";
import { resolvePackRuntime } from "../../../lib/agent-runtime/registry";
import { executeLeasedTriggerDispatch } from "./trigger-execution";
import { dispatchDueTriggers } from "./trigger-scheduler";
import { recoverExpiredTriggerDispatches } from "./trigger-recovery";
import { handleCreateTriggerDispatch, handleReplayTriggerDispatch } from "./triggers";
import type { ControlTriggerRow, ControlTriggerDispatchRow } from "./types";
import type { DurableTriggerInvocation } from "./durable-trigger-links";
import { controlPlane } from "../../../examples/document-review/control-plane";
import { createRuntimeClient } from "../../../packages/client/src/runtime-client";
import { recoverDurableExecutions } from "./durable-recovery";
import {
  claimDurableRecovery,
  closeDurableRecovery,
  releaseDurableRecovery,
} from "./durable-recovery-store";
import { executeRuntimeToolBinding } from "./runtime-tool-execution";
import { captureRuntimeContext, handleListContextSnapshots } from "./runtime-context";
import { createRuntimeStatePort } from "./runtime-state";
import { reserveRuntimeUsage, settleRuntimeUsage } from "./runtime-usage";
import { createRuntimeModelPort } from "./runtime-models";
import type { DurableAttemptAuthority } from "./durable-attempt-authority";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentBehaviorSnapshotFromTemplate,
  toPackTemplate,
} from "./agent-behavior-templates";
import { agentManifestRegistry } from "../../../generated/agent-runtime/manifests";
import {
  admitDurableExecution,
  completeDurableExecution,
  loadDurableStepOutput,
  startDurableExecution,
  claimDurableStep,
  finishDurableStep,
  requireDurableExecutionAuthority,
} from "./durable-execution-store";
import { exportCollections, loadCollection } from "./workspace-data-export-core";
import { handleDurableDeploymentProbe } from "./durable-deployment-probe";
import {
  acquireDeploymentFence,
  activateDeploymentFence,
  requireDeploymentFence,
  releaseDeploymentFence,
  loadRequiredDurableHandlers,
  withDurableDeploymentGate,
} from "../../../scripts/durable-deployment-gate";
import { purgeWorkspace, processDataLifecycleJobs } from "./workspace-data-jobs";
import {
  prepareDurableApproval,
  consumeDurableApproval,
  decideDurableApproval,
  expireDurableApprovals,
} from "./durable-approvals";
import { deliverDurableApprovalWakes } from "./durable-approval-delivery";
import {
  handleApproveToolApproval,
  handleDenyToolApproval,
  handleListToolApprovals,
} from "./tool-approvals";
import { purgeDurableEngines, beginDurableEngineDispatch } from "./durable-engine-lifecycle";
import type { AgentIdentity, ControlDataJobRow, D1PreparedStatement, Env } from "./types";
const manifest = agentManifestRegistry["document-review"].module;
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const identity: AgentIdentity = { scope: { userId: "u", workspaceId: "w" }, agentId: "a" };
const fixture = () => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec(`INSERT INTO agents (id,workspace_id,name,status,created_by_user_id,created_at,updated_at)
    VALUES ('a','w','Agent','active','u','now','now');
    INSERT INTO users (id,status,created_at,updated_at) VALUES ('u','active','now','now');
    INSERT INTO workspaces (id,account_id,account_source,name,status,created_by_user_id,created_at,updated_at)
      VALUES ('w','acct','local','Workspace','active','u','now','now');
    INSERT INTO memberships (id,user_id,workspace_id,role,status,created_at,updated_at)
      VALUES ('m','u','w','owner','active','now','now');
    INSERT INTO chat_threads (thread_id,session_id,user_id,workspace_id,agent_id,status,created_at,updated_at,last_seen_at)
      VALUES ('t','s','u','w','a','active','now','now','now');`);
  type Statement = D1PreparedStatement & {
    execute(): { success: true; meta: { changes: number } };
  };
  const env = {
    DB: {
      prepare(query: string): Statement {
        let values: unknown[] = [];
        const statement: Statement = {
          bind(...parameters) {
            if (parameters.length !== (query.match(/\?/g)?.length ?? 0))
              throw new Error("D1 bind count mismatch");
            values = parameters;
            return statement;
          },
          async first<T>() {
            return (db.prepare(query).get(...(values as never[])) ?? null) as T | null;
          },
          async all<T>() {
            return { results: db.prepare(query).all(...(values as never[])) as T[] };
          },
          async run() {
            return statement.execute();
          },
          execute() {
            const before = Number(db.prepare("SELECT total_changes() n").get()!.n);
            db.prepare(query).run(...(values as never[]));
            return {
              success: true,
              meta: { changes: Number(db.prepare("SELECT total_changes() n").get()!.n) - before },
            };
          },
        };
        return statement;
      },
      async batch(statements: Statement[]) {
        db.exec("BEGIN");
        try {
          const results = statements.map((statement) => statement.execute());
          db.exec("COMMIT");
          return results;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
  } as unknown as Env;
  env.OPENROUTER_API_KEY = "synthetic-test-key";
  env.OPERLOOM_CONFORMANCE_MODE = "true";
  const current = createAgentBehaviorSnapshotFromTemplate(toPackTemplate(manifest));
  const old = {
    ...current,
    version: manifest.version,
    pack: { ...current.pack!, version: manifest.version },
  };
  db.prepare("UPDATE agents SET data_json = ? WHERE id = 'a'").run(
    JSON.stringify({ profile: "operator", custom: { retained: true }, behavior: old }),
  );
  return { db, env, old };
};

const submission = {
  submissionKey: "observe-1",
  workflowType: "document-review.review",
  workflowVersion: "1",
  definitionHash: "a".repeat(64),
  packId: "document-review",
  packVersion: "1.0.0",
  runtimeVersion: "1.0.0",
  input: { text: "Observe capacity" },
  maxSteps: 4,
  maxDurationMs: 600000,
  maxActiveRuns: 4,
  settings: { version: 3, values: { strictness: "strict" } },
};
const pins = {
  definitionHash: submission.definitionHash,
  workflowVersion: "1",
  runtimeVersion: "1.0.0",
};
const step = {
  key: "observe",
  version: "1",
  payload: { documentId: "one" },
  outputSchema: {
    type: "object",
    properties: { capacity: { type: "integer" } },
    required: ["capacity"],
    additionalProperties: false,
  },
  replaySafe: false,
  maxAttempts: 1,
  timeoutMs: 30000,
};
const setupRun = async (env: Env, changes: Partial<typeof submission> = {}) => {
  const { execution } = await admitDurableExecution(env, identity, { ...submission, ...changes });
  await startDurableExecution(env, identity, execution.run_id, pins);
  return execution.run_id;
};
const activeClaim = async (env: Env, runId: string, change: Partial<typeof step> = {}) => {
  const claim = await claimDurableStep(env, identity, runId, { ...step, ...change });
  if (!claim.execute) throw new Error("Expected a new attempt");
  return claim;
};
const expire = (db: DatabaseSync, id: string) =>
  db
    .prepare("UPDATE control_durable_steps SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?")
    .run(id);
const count = (db: DatabaseSync, table: string) =>
  db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n;
const complete = { status: "completed" as const, output: { capacity: 7 } };

const engineFixture = (env: Env, initial = "running") => {
  let observed = initial;
  const status = vi.fn(async () => ({ status: observed }));
  const terminate = vi.fn(async () => {
    observed = "terminated";
  });
  const create = vi.fn(async ({ id }: { id: string }) => ({ id }));
  const get = vi.fn(async () => ({ status, terminate }));
  const deleteBatch = vi.fn(async (ids: string[]) => ({
    deleted: ids.map((id) => ({ id })),
    errors: [] as { id: string; code: number; message: string }[],
  }));
  env.DURABLE_WORKFLOWS = { create, get, deleteBatch };
  return { status, terminate, create, get, deleteBatch };
};
const dueAgain = (db: DatabaseSync) =>
  db.exec("UPDATE control_durable_executions SET recovery_next_at='1970-01-01T00:00:00.000Z'");

const reviewDefinition = {
  key: "review",
  version: "1",
  summary: "Review the observed capacity",
  payload: { capacity: 7, version: 2 },
  timeoutMs: 60000,
};
const triggerFixture = (db: DatabaseSync) => {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO control_triggers
    (id,user_id,workspace_id,agent_id,pack_id,pack_trigger_id,kind,workflow_type,status,execution_json,config_json,input_json,max_concurrent_runs,version,next_trigger_at,created_by_user_id,created_at,updated_at)
    VALUES ('tr','u','w','a','document-review','document-monitor','monitor','document-review.review','enabled',
      '{"mode":"dry_run","runtime":"durable"}','{"intervalSeconds":60}','{"documentId":"background","text":"Background evidence","delayMs":1}',1,1,?,'u',?,?)`).run(
    now,
    now,
    now,
  );
  db.prepare(`INSERT INTO control_trigger_dispatches
    (id,trigger_id,user_id,workspace_id,agent_id,idempotency_key,source,status,attempt_count,lease_owner,lease_expires_at,received_at,payload_json,error_json,created_at,updated_at)
    VALUES ('dispatch','tr','u','w','a','event','monitor','leased',1,'owner',?,?,'{"skippedOccurrences":2}','{}',?,?)`).run(
    new Date(Date.now() + 60000).toISOString(),
    now,
    now,
    now,
  );
  const trigger = db
    .prepare("SELECT * FROM control_triggers WHERE id='tr'")
    .get() as unknown as ControlTriggerRow;
  const dispatch = db
    .prepare("SELECT * FROM control_trigger_dispatches WHERE id='dispatch'")
    .get() as unknown as ControlTriggerDispatchRow;
  const invocation: DurableTriggerInvocation = {
    source: "trigger",
    triggerId: "tr",
    dispatchId: "dispatch",
    leaseOwner: "owner",
    attemptCount: 1,
    triggerSource: "monitor",
    idempotencyKey: "event",
    scheduledFor: null,
    previousRunId: null,
    triggerSnapshot: {
      inputJson: trigger.input_json,
      executionJson: trigger.execution_json,
      configJson: trigger.config_json,
      payloadJson: dispatch.payload_json,
    },
  };
  return { trigger, dispatch, invocation };
};

describe("durable deployment gate", () => {
  const fence = { deploymentId: "deployment-1", artifactSha256: "a".repeat(64) };
  const adapter = (db: DatabaseSync) => async (sql: string) => db.prepare(sql).all();

  it("activates a generation atomically and rejects stale Worker admissions after release", async () => {
    const { db, env } = fixture();
    const sql = adapter(db);
    const original = await admitDurableExecution(env, identity, submission);
    const pinned = db
      .prepare("SELECT data_json FROM control_runs WHERE id = ?")
      .get(original.execution.run_id) as { data_json: string };
    expect(JSON.parse(pinned.data_json)).toMatchObject({
      settingsVersion: 3,
      settings: { strictness: "strict" },
    });
    await acquireDeploymentFence(sql, fence);
    db.exec(
      "CREATE TRIGGER fail_activation BEFORE INSERT ON control_durable_deployment_generation BEGIN SELECT RAISE(ABORT,'activation failed'); END",
    );
    await expect(activateDeploymentFence(sql, fence)).rejects.toThrow("activation failed");
    await requireDeploymentFence(sql, fence);
    expect(count(db, "control_durable_deployment_generation")).toBe(0);
    db.exec("DROP TRIGGER fail_activation");
    await activateDeploymentFence(sql, fence);
    expect(count(db, "control_durable_deployment_fence")).toBe(0);
    await activateDeploymentFence(sql, fence);
    expect(count(db, "control_durable_deployment_generation")).toBe(1);
    await expect(
      admitDurableExecution(env, identity, { ...submission, submissionKey: "new" }),
    ).rejects.toMatchObject({ code: "durable_deployment_changed" });
    expect(count(db, "control_runs")).toBe(1);
    expect((await admitDurableExecution(env, identity, submission)).execution.run_id).toBe(
      original.execution.run_id,
    );
    env.OPERLOOM_DEPLOYMENT_ID = fence.deploymentId;
    const admitted = await admitDurableExecution(env, identity, {
      ...submission,
      submissionKey: "new",
    });
    expect(admitted.accepted).toBe(true);
    expect(() =>
      db
        .prepare("UPDATE control_durable_executions SET deployment_id='other' WHERE run_id=?")
        .run(admitted.execution.run_id),
    ).toThrow("durable_deployment_pin_immutable");
    await startDurableExecution(env, identity, original.execution.run_id, pins);
  });

  it("fences old-worker admissions without expiring, preserves replays and excludes closed runs", async () => {
    const { db, env } = fixture();
    const sql = adapter(db);
    const first = await admitDurableExecution(env, identity, submission);
    await acquireDeploymentFence(sql, fence);
    db.exec("UPDATE control_durable_deployment_fence SET acquired_at='1900-01-01'");
    expect((await admitDurableExecution(env, identity, submission)).execution.run_id).toBe(
      first.execution.run_id,
    );
    await expect(
      admitDurableExecution(env, identity, { ...submission, submissionKey: "second" }),
    ).rejects.toMatchObject({ code: "durable_deployment_in_progress" });
    expect(count(db, "control_runs")).toBe(1);
    expect(await loadRequiredDurableHandlers(sql, fence)).toEqual([
      {
        pack_id: submission.packId,
        pack_version: submission.packVersion,
        workflow_type: submission.workflowType,
        workflow_version: submission.workflowVersion,
        runtime_version: submission.runtimeVersion,
        definition_hash: submission.definitionHash,
      },
    ]);
    await startDurableExecution(env, identity, first.execution.run_id, pins);
    expect(await loadRequiredDurableHandlers(sql, fence)).toHaveLength(1);
    await completeDurableExecution(
      env,
      identity,
      first.execution.run_id,
      { ok: true, output: {} },
      pins,
    );
    expect(await loadRequiredDurableHandlers(sql, fence)).toEqual([]);
    await releaseDeploymentFence(sql, fence);
    expect(
      (await admitDurableExecution(env, identity, { ...submission, submissionKey: "second" }))
        .accepted,
    ).toBe(true);
  });

  it("rejects overlapping deployments and releases only its own preflight failure", async () => {
    const { db } = fixture();
    const sql = adapter(db);
    await acquireDeploymentFence(sql, fence);
    const deploy = vi.fn(async () => {});
    await expect(
      withDurableDeploymentGate({
        sql,
        fence: { ...fence, deploymentId: "other" },
        check: async () => {},
        deploy,
        verify: async () => {},
      }),
    ).rejects.toThrow();
    await requireDeploymentFence(sql, fence);
    await expect(
      releaseDeploymentFence(sql, { ...fence, deploymentId: "other" }),
    ).rejects.toThrow();
    await releaseDeploymentFence(sql, fence);
    await expect(
      withDurableDeploymentGate({
        sql,
        fence,
        check: async () => {
          throw new Error("incompatible");
        },
        deploy,
        verify: async () => {},
      }),
    ).rejects.toThrow("incompatible");
    expect(deploy).not.toHaveBeenCalled();
    expect(count(db, "control_durable_deployment_fence")).toBe(0);
  });

  it.each(["upload", "verify"])(
    "retains uncertain %s fences and resumes the same artifact",
    async (phase) => {
      const { db } = fixture();
      const sql = adapter(db);
      const input = {
        sql,
        fence,
        check: async () => {},
        deploy: async () => {},
        verify: async () => {},
      };
      await expect(
        withDurableDeploymentGate({
          ...input,
          ...(phase === "upload"
            ? {
                deploy: async () => {
                  throw new Error("lost response");
                },
              }
            : {
                verify: async () => {
                  throw new Error("not observed");
                },
              }),
        }),
      ).rejects.toThrow();
      await requireDeploymentFence(sql, fence);
      await expect(
        withDurableDeploymentGate({
          ...input,
          resume: true,
          fence: { ...fence, artifactSha256: "b".repeat(64) },
        }),
      ).rejects.toThrow();
      await expect(
        withDurableDeploymentGate({
          ...input,
          resume: true,
          check: async () => {
            throw new Error("incompatible");
          },
        }),
      ).rejects.toThrow();
      await requireDeploymentFence(sql, fence);
      await withDurableDeploymentGate({ ...input, resume: true });
      expect(count(db, "control_durable_deployment_fence")).toBe(0);
    },
  );

  it("checks actual handlers, flags and hashes through an authenticated local-only probe", async () => {
    const { env } = fixture();
    engineFixture(env);
    Object.assign(env, {
      OPERLOOM_LOCAL_API_ENABLED: "true",
      OPERLOOM_ENVIRONMENT: "local",
      OPERLOOM_LOCAL_API_TOKEN: "probe-token",
    });
    const runtime = resolvePackRuntime(manifest.id, manifest.version);
    if (!runtime.runnable) throw new Error("Fixture runtime unavailable");
    const workflow = runtime.controlPlane.workflows.find((item) => item.durable)!;
    const pin = {
      pack_id: manifest.id,
      pack_version: manifest.version,
      workflow_type: workflow.type,
      workflow_version: workflow.durable!.version,
      runtime_version: runtime.runtimeVersion,
      definition_hash: await durableWorkflowDefinitionHash(runtime, workflow),
    };
    const request = (pins: unknown = [pin], origin = "http://127.0.0.1", token = "probe-token") =>
      new Request(`${origin}/__operloom/durable-deployment-probe`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(pins),
      });
    expect(await (await handleDurableDeploymentProbe(request(), env)).json()).toEqual({
      results: [{ ok: true }],
    });
    const simulation = runtime.controlPlane.workflows.find(
      (item) => item.type === "document-review.simulate",
    )!;
    const simulationPin = {
      ...pin,
      workflow_type: simulation.type,
      workflow_version: simulation.durable!.version,
      definition_hash: await durableWorkflowDefinitionHash(runtime, simulation),
    };
    expect(
      await (await handleDurableDeploymentProbe(request([simulationPin]), env)).json(),
    ).toEqual({
      results: [{ ok: true }],
    });
    for (const change of [
      { definition_hash: "bad" },
      { workflow_version: "999" },
      { runtime_version: "999" },
      { pack_id: "missing" },
    ]) {
      const result = (await (
        await handleDurableDeploymentProbe(request([{ ...pin, ...change }]), env)
      ).json()) as { results: { ok: boolean }[] };
      expect(result.results[0]!.ok).toBe(false);
    }
    env.DURABLE_WORKFLOWS = undefined;
    expect(await (await handleDurableDeploymentProbe(request(), env)).json()).toEqual({
      results: [{ ok: false, code: "durable_binding_missing" }],
    });
    expect((await handleDurableDeploymentProbe(request([{}]), env)).status).toBe(400);
    expect((await handleDurableDeploymentProbe(request("x".repeat(65536)), env)).status).toBe(413);
    expect(
      (await handleDurableDeploymentProbe(request([pin], "http://127.0.0.1", "wrong"), env)).status,
    ).toBe(401);
    expect(
      (await handleDurableDeploymentProbe(request([pin], "https://hosted.example"), env)).status,
    ).toBe(404);
    env.OPERLOOM_ENVIRONMENT = "production";
    expect((await handleDurableDeploymentProbe(request(), env)).status).toBe(404);
  });
});

describe("durable trigger admission", () => {
  it("hands a monitor to the native runtime without a callback host or request lease", async () => {
    const { env, db } = fixture();
    const engine = engineFixture(env);
    const item = triggerFixture(db);
    expect(await executeLeasedTriggerDispatch(env, item)).toMatchObject({ ok: true, status: 202 });
    const link = db.prepare("SELECT * FROM control_durable_trigger_links").get()!;
    expect(
      db
        .prepare(
          "SELECT status,run_id,lease_owner,lease_expires_at FROM control_trigger_dispatches",
        )
        .get(),
    ).toMatchObject({
      status: "running",
      run_id: link.run_id,
      lease_owner: null,
      lease_expires_at: null,
    });
    expect(engine.create).toHaveBeenCalledTimes(1);
    expect(
      await recoverExpiredTriggerDispatches(env, { now: new Date(Date.now() + 180000) }),
    ).toEqual({ inspected: 0, recovered: 0 });
    expect(
      JSON.parse(String(db.prepare("SELECT data_json FROM control_runs").get()!.data_json)),
    ).toMatchObject({ logicalEventId: "dispatch", triggerDispatchId: "dispatch" });
    expect(count(db, "control_durable_executions")).toBe(1);
    expect(await executeLeasedTriggerDispatch(env, item)).toMatchObject({ ok: true, status: 202 });
    expect(count(db, "control_durable_executions")).toBe(1);
    expect(engine.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    "UPDATE control_trigger_dispatches SET lease_owner='other'",
    "UPDATE control_trigger_dispatches SET attempt_count=2",
    "UPDATE control_trigger_dispatches SET lease_expires_at='2000-01-01T00:00:00.000Z'",
    "UPDATE control_trigger_dispatches SET payload_json='{}'",
    "UPDATE control_triggers SET status='paused'",
    "UPDATE control_triggers SET input_json='{}'",
    "UPDATE control_triggers SET workspace_id='foreign'",
    "UPDATE memberships SET role='viewer'",
  ])("rolls back every admission write when dispatch authority changes: %s", async (sql) => {
    const { env, db } = fixture();
    const { invocation } = triggerFixture(db);
    db.exec(sql);
    await expect(
      admitDurableExecution(env, identity, submission, invocation),
    ).rejects.toMatchObject({ code: "durable_admission_denied" });
    for (const table of [
      "control_runs",
      "control_workflow_intents",
      "control_durable_executions",
      "control_durable_trigger_links",
      "control_plane_events",
    ])
      expect(count(db, table)).toBe(0);
  });

  it("pins one logical event across delivery attempts and projects terminal outcome", async () => {
    const { env, db } = fixture();
    const { invocation } = triggerFixture(db);
    const { execution } = await admitDurableExecution(env, identity, submission, invocation);
    expect(
      (
        await admitDurableExecution(env, identity, submission, {
          ...invocation,
          leaseOwner: "new",
          attemptCount: 2,
        })
      ).execution.run_id,
    ).toBe(execution.run_id);
    await expect(
      admitDurableExecution(env, identity, { ...submission, input: { changed: true } }, invocation),
    ).rejects.toMatchObject({ code: "durable_submission_conflict" });
    await startDurableExecution(env, identity, execution.run_id, pins);
    await completeDurableExecution(env, identity, execution.run_id, { ok: true, output: {} }, pins);
    expect(db.prepare("SELECT status FROM control_trigger_dispatches").get()!.status).toBe(
      "completed",
    );
    expect((await handleReplayTriggerDispatch(env, identity, "dispatch")).status).toBe(409);
  });

  it("bounds ingress backlog and rejects conflicting manual redelivery", async () => {
    const { env, db } = fixture();
    triggerFixture(db);
    const dispatch = (key: string, payload: Record<string, unknown> = {}) =>
      handleCreateTriggerDispatch(
        new Request("https://api", {
          method: "POST",
          body: JSON.stringify({ idempotencyKey: key, payload }),
        }),
        env,
        identity,
        "tr",
      );
    for (let index = 0; index < 100; index++) {
      const response = await dispatch(`pending-${index}`);
      expect(response.status, await response.text()).toBe(201);
    }
    expect((await dispatch("over-capacity")).status).toBe(409);
    expect((await dispatch("pending-0")).status).toBe(200);
    expect((await dispatch("pending-0", { text: "Changed" })).status).toBe(409);
    expect(
      db.prepare("SELECT COUNT(*) n FROM control_trigger_dispatches WHERE status='pending'").get()!
        .n,
    ).toBe(100);
  });

  it("rolls back failed event publication and rechecks membership after admission", async () => {
    const { env, db } = fixture();
    const { invocation } = triggerFixture(db);
    db.exec(
      "CREATE TRIGGER fail_link BEFORE INSERT ON control_plane_events WHEN NEW.type='trigger.dispatch.started' BEGIN SELECT RAISE(ABORT,'late'); END",
    );
    await expect(admitDurableExecution(env, identity, submission, invocation)).rejects.toThrow();
    expect(count(db, "control_runs")).toBe(0);
    expect(count(db, "control_durable_trigger_links")).toBe(0);
    expect(db.prepare("SELECT status FROM control_trigger_dispatches").get()!.status).toBe(
      "leased",
    );
    db.exec("DROP TRIGGER fail_link");
    const { execution } = await admitDurableExecution(env, identity, submission, invocation);
    await startDurableExecution(env, identity, execution.run_id, pins);
    db.exec("UPDATE memberships SET role='viewer'");
    await expect(
      requireDurableExecutionAuthority(env, identity, execution.run_id),
    ).rejects.toMatchObject({ code: "durable_execution_fenced" });
  });

  it.each(["status='paused'", "input_json='{}'"])(
    "revokes active attempts on trigger change: %s",
    async (change) => {
      const { env, db } = fixture();
      const { invocation } = triggerFixture(db);
      const { execution } = await admitDurableExecution(env, identity, submission, invocation);
      await startDurableExecution(env, identity, execution.run_id, pins);
      const claim = await activeClaim(env, execution.run_id);
      db.exec(`UPDATE control_triggers SET ${change}`);
      expect(db.prepare("SELECT status FROM control_runs").get()!.status).toBe("cancelled");
      expect(db.prepare("SELECT status FROM control_workflow_intents").get()!.status).toBe(
        "cancelled",
      );
      expect(db.prepare("SELECT status FROM control_trigger_dispatches").get()!.status).toBe(
        "cancelled",
      );
      await expect(
        finishDurableStep(env, identity, execution.run_id, claim.stepId, claim.attemptId, complete),
      ).rejects.toThrow();
    },
  );

  it("exports trigger links by run identity within the workspace and fences admission", async () => {
    const { env, db } = fixture();
    const { invocation } = triggerFixture(db);
    db.exec(`INSERT INTO control_workspace_write_fences (workspace_id,job_id,status,lease_owner,lease_expires_at,acquired_at,updated_at)
      VALUES ('w','export','active','owner','2999-01-01T00:00:00Z','now','now')`);
    await expect(admitDurableExecution(env, identity, submission, invocation)).rejects.toThrow();
    expect(count(db, "control_runs")).toBe(0);
    expect(count(db, "control_durable_trigger_links")).toBe(0);
    db.exec("DELETE FROM control_workspace_write_fences");
    const { execution } = await admitDurableExecution(env, identity, submission, invocation);
    const collection = exportCollections.find(
      (item) => item.name === "control_durable_trigger_links",
    )!;
    expect(await loadCollection(env, identity, collection)).toMatchObject([
      { run_id: execution.run_id, dispatch_id: "dispatch", workspace_id: "w" },
    ]);
    expect(
      await loadCollection(
        env,
        { ...identity, scope: { ...identity.scope, workspaceId: "foreign" } },
        collection,
      ),
    ).toEqual([]);
  });

  it("coalesces repeat monitor occurrences into one pending observation", async () => {
    const { env, db } = fixture();
    triggerFixture(db);
    const now = new Date();
    expect((await dispatchDueTriggers(env, { now })).created).toBe(1);
    expect(
      (await dispatchDueTriggers(env, { now: new Date(now.getTime() + 120000) })).created,
    ).toBe(0);
    const pending = db
      .prepare("SELECT * FROM control_trigger_dispatches WHERE status='pending'")
      .all();
    expect(pending).toHaveLength(1);
    expect(JSON.parse(String(pending[0]!.payload_json)).coalescedOccurrences).toBe(1);
    // Concurrent or delayed ticks must neither count the same occurrence twice
    // nor move the pending observation's timestamp backwards.
    const row = pending[0]!;
    const keys = Object.keys(row);
    const repeat = db.prepare(
      `INSERT OR IGNORE INTO control_trigger_dispatches (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
    );
    for (const scheduledFor of [row.scheduled_for, new Date(now.getTime() - 60000).toISOString()]) {
      const replay = { ...row, id: "duplicate-tick", scheduled_for: scheduledFor };
      repeat.run(...(keys.map((key) => replay[key as keyof typeof replay]) as never[]));
    }
    expect(
      db.prepare("SELECT * FROM control_trigger_dispatches WHERE status='pending'").all(),
    ).toEqual(pending);
  });
});

describe("durable approval pauses", () => {
  it("persists one immutable request, blocks new steps, and consumes an approved review once", async () => {
    const { env, db } = fixture();
    engineFixture(env);
    const runId = await setupRun(env);
    const [first, replay] = await Promise.all([
      prepareDurableApproval(env, identity, runId, reviewDefinition),
      prepareDurableApproval(env, identity, runId, reviewDefinition),
    ]);
    expect(first.id).toBe(replay.id);
    expect(count(db, "control_durable_approvals")).toBe(1);
    expect(db.prepare("SELECT status FROM control_runs").get()!.status).toBe("waiting");
    await expect(claimDurableStep(env, identity, runId, step)).rejects.toThrow();
    expect(
      (await handleListToolApprovals(new Request("https://api/tools/approvals"), env, identity))
        .status,
    ).toBe(200);
    expect(
      (
        await handleApproveToolApproval(
          new Request("https://api", { method: "POST" }),
          env,
          identity,
          first.id,
        )
      ).status,
    ).toBe(200);
    expect(db.prepare("SELECT status FROM control_runs").get()!.status).toBe("waiting");
    const consumed = await consumeDurableApproval(env, identity, first.id, first.request_hash);
    expect(consumed).toMatchObject({
      id: first.id,
      requestHash: first.request_hash,
      decidedByUserId: "u",
    });
    expect(await consumeDurableApproval(env, identity, first.id, first.request_hash)).toEqual(
      consumed,
    );
    expect(db.prepare("SELECT status FROM control_runs").get()!.status).toBe("running");
    expect(
      db.prepare("SELECT COUNT(*) count FROM control_plane_events WHERE type='run.resumed'").get()!
        .count,
    ).toBe(1);
    expect(await claimDurableStep(env, identity, runId, step)).toMatchObject({ execute: true });
  });

  it("rejects changed review content and scoped lookups without changing the original request", async () => {
    const { env, db } = fixture();
    engineFixture(env);
    const runId = await setupRun(env);
    const row = await prepareDurableApproval(env, identity, runId, reviewDefinition);
    await expect(
      prepareDurableApproval(env, identity, runId, {
        ...reviewDefinition,
        payload: { capacity: 8 },
      }),
    ).rejects.toMatchObject({ code: "durable_approval_conflict" });
    expect(() => db.exec("UPDATE control_durable_approvals SET payload_json='{}'")).toThrow(
      "durable_approval_immutable",
    );
    expect(
      (await decideDurableApproval(env, { ...identity, agentId: "other" }, row.id, "approved"))
        .status,
    ).toBe(404);
    expect(db.prepare("SELECT status FROM control_durable_approvals").get()!.status).toBe(
      "requested",
    );
  });

  it("atomically rejects a decision after membership revocation or a kill switch", async () => {
    const { env, db } = fixture();
    engineFixture(env);
    const runId = await setupRun(env);
    const row = await prepareDurableApproval(env, identity, runId, reviewDefinition);
    db.exec("UPDATE memberships SET role='member'");
    expect(
      (
        await handleApproveToolApproval(
          new Request("https://api", { method: "POST" }),
          env,
          identity,
          row.id,
        )
      ).status,
    ).toBe(403);
    db.exec("UPDATE memberships SET role='owner'");
    db.exec(`INSERT INTO control_kill_switches (id,user_id,workspace_id,scope_kind,scope_id,enabled,reason,created_by_user_id,created_at,updated_at)
      VALUES ('kill','u','w','workspace','w',1,'test','u','now','now')`);
    expect((await decideDurableApproval(env, identity, row.id, "approved")).status).toBe(409);
    expect(db.prepare("SELECT status FROM control_durable_approvals").get()!.status).toBe(
      "requested",
    );
  });

  it("rechecks the approver role at consumption and does not grant execution from a wake alone", async () => {
    const { env, db } = fixture();
    engineFixture(env);
    const runId = await setupRun(env);
    const row = await prepareDurableApproval(env, identity, runId, reviewDefinition);
    await expect(
      consumeDurableApproval(env, identity, row.id, row.request_hash),
    ).rejects.toMatchObject({ code: "durable_approval_requested" });
    await decideDurableApproval(env, identity, row.id, "approved");
    db.exec("UPDATE memberships SET role='member'");
    await expect(
      consumeDurableApproval(env, identity, row.id, row.request_hash),
    ).rejects.toMatchObject({ code: "durable_approval_consumption_denied" });
    expect(db.prepare("SELECT status FROM control_runs").get()!.status).toBe("waiting");
  });

  it.each(["requested", "approved"])(
    "expires an unconsumed %s review without rewriting an approved decision",
    async (status) => {
      const { env, db } = fixture();
      engineFixture(env);
      const runId = await setupRun(env);
      const row = await prepareDurableApproval(env, identity, runId, reviewDefinition);
      if (status === "approved") await decideDurableApproval(env, identity, row.id, "approved");
      // Model a retained historical record whose expiry has passed.
      db.exec(
        "DROP TRIGGER immutable_durable_approval; UPDATE control_durable_approvals SET expires_at='2000-01-01T00:00:00.000Z'",
      );
      await expireDurableApprovals(env);
      expect(db.prepare("SELECT status FROM control_durable_approvals").get()!.status).toBe(
        status === "approved" ? "approved" : "expired",
      );
      expect(db.prepare("SELECT status FROM control_runs").get()!.status).toBe("blocked");
      expect(db.prepare("SELECT status FROM control_workflow_intents").get()!.status).toBe(
        "blocked",
      );
      expect(db.prepare("SELECT status FROM control_durable_executions").get()!.status).toBe(
        "closed",
      );
    },
  );

  it("denies or cancels a pending review without resuming the run", async () => {
    const { env, db } = fixture();
    engineFixture(env);
    const runId = await setupRun(env);
    const row = await prepareDurableApproval(env, identity, runId, reviewDefinition);
    expect(
      (
        await handleDenyToolApproval(
          new Request("https://api", {
            method: "POST",
            body: JSON.stringify({ reason: "Capacity changed" }),
          }),
          env,
          identity,
          row.id,
        )
      ).status,
    ).toBe(200);
    expect(db.prepare("SELECT status FROM control_runs").get()!.status).toBe("cancelled");
    expect(db.prepare("SELECT status FROM control_durable_approvals").get()!.status).toBe("denied");
    expect(db.prepare("SELECT status FROM control_approval_requests").get()!.status).toBe("denied");
    expect(
      (
        await handleApproveToolApproval(
          new Request("https://api", { method: "POST" }),
          env,
          identity,
          row.id,
        )
      ).status,
    ).toBe(409);
  });

  it("rolls back an approval decision if its durable event cannot be published", async () => {
    const { env, db } = fixture();
    engineFixture(env);
    const runId = await setupRun(env);
    const row = await prepareDurableApproval(env, identity, runId, reviewDefinition);
    db.exec(
      "CREATE TRIGGER fail_approval_event BEFORE INSERT ON control_plane_events WHEN NEW.type='approval.approved' BEGIN SELECT RAISE(ABORT,'event_failed'); END;",
    );
    await expect(decideDurableApproval(env, identity, row.id, "approved")).rejects.toThrow(
      "event_failed",
    );
    expect(
      db.prepare("SELECT status,wake_next_at FROM control_durable_approvals").get(),
    ).toMatchObject({ status: "requested", wake_next_at: null });
    expect(db.prepare("SELECT status FROM control_approval_requests").get()!.status).toBe(
      "requested",
    );
  });

  it("leases wake delivery, retries response loss without provider payloads, and skips consumed approvals", async () => {
    const { env, db } = fixture();
    const engine = engineFixture(env);
    const sendEvent = vi.fn(async () => {});
    engine.get.mockImplementation(async () => ({
      status: engine.status,
      terminate: engine.terminate,
      sendEvent,
    }));
    const runId = await setupRun(env);
    const row = await prepareDurableApproval(env, identity, runId, reviewDefinition);
    await decideDurableApproval(env, identity, row.id, "approved");
    sendEvent.mockRejectedValueOnce(new Error("private provider detail"));
    await Promise.all([deliverDurableApprovalWakes(env), deliverDurableApprovalWakes(env)]);
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(
      db.prepare("SELECT wake_error_code FROM control_durable_approvals").get()!.wake_error_code,
    ).toBe("durable_approval_wake_retry");
    db.exec("UPDATE control_durable_approvals SET wake_next_at='2000-01-01T00:00:00.000Z'");
    expect(await deliverDurableApprovalWakes(env)).toMatchObject({ delivered: 1 });
    expect(sendEvent).toHaveBeenLastCalledWith({ type: row.id, payload: { approvalId: row.id } });
    await consumeDurableApproval(env, identity, row.id, row.request_hash);
    expect(await deliverDurableApprovalWakes(env)).toMatchObject({ selected: 0 });
  });
});

const preparePurge = (db: DatabaseSync) => {
  db.exec(`UPDATE workspaces SET status='purging',purge_after='2000-01-01T00:00:00Z';
    INSERT INTO control_data_jobs (id,user_id,workspace_id,kind,status,cursor_json,created_by_user_id,created_at,updated_at)
    VALUES ('purge','u','w','purge','running','{"phase":"objects_deleted"}','u','now','now')`);
  return db
    .prepare("SELECT * FROM control_data_jobs WHERE id='purge'")
    .get() as unknown as ControlDataJobRow;
};

describe("native workflow deletion", () => {
  it("does not reuse a native identity after deleting and recreating the same scoped submission", async () => {
    const first = fixture(),
      second = fixture();
    engineFixture(first.env);
    const original = await admitDurableExecution(first.env, identity, submission);
    const job = preparePurge(first.db);
    await purgeWorkspace(first.env, identity, job);
    const recreated = await admitDurableExecution(second.env, identity, submission);
    expect(recreated.execution.instance_id).not.toBe(original.execution.instance_id);
    expect(
      (await admitDurableExecution(second.env, identity, submission)).execution.instance_id,
    ).toBe(recreated.execution.instance_id);
  });
  it("records executions without engine lifecycle evidence as uncertain without changing their pinned input", async () => {
    const modern = fixture();
    const { execution } = await admitDurableExecution(modern.env, identity, submission);
    const { env, db } = fixture();
    const columns = db
      .prepare("PRAGMA table_info(control_durable_executions)")
      .all()
      .map((row) => row.name as string)
      .filter((name) => name !== "engine_lifecycle_version");
    const original = modern.db.prepare("SELECT * FROM control_durable_executions").get()!;
    db.prepare(
      `INSERT INTO control_durable_executions (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    ).run(...columns.map((name) => original[name]!));
    expect(
      db.prepare("SELECT input_json,engine_deleted_at FROM control_durable_executions").get(),
    ).toMatchObject({ input_json: execution.input_json, engine_deleted_at: null });
    expect(
      db.prepare("SELECT run_id,status FROM control_durable_engine_dispatches").get(),
    ).toMatchObject({ run_id: execution.run_id, status: "outcome_unknown" });
    const job = preparePurge(db);
    await expect(purgeWorkspace(env, identity, job)).rejects.toThrow(
      "durable_engine_dispatch_unresolved",
    );
  });

  it("fences old-worker admissions that arrive after the migration during a rolling deployment", async () => {
    const { env, db } = fixture();
    await admitDurableExecution(env, identity, submission);
    const columns = db
      .prepare("PRAGMA table_info(control_durable_executions)")
      .all()
      .map((row) => row.name as string)
      .filter((name) => name !== "engine_lifecycle_version");
    const replacements: Record<string, string> = {
      run_id: "'legacy-run'",
      instance_id: "'legacy-instance'",
      workflow_intent_id: "'legacy-intent'",
      submission_key: "'legacy-submission'",
    };
    db.exec(
      `INSERT INTO control_durable_executions (${columns.join(",")}) SELECT ${columns.map((name) => replacements[name] ?? name).join(",")} FROM control_durable_executions`,
    );
    expect(db.prepare("SELECT run_id,status FROM control_durable_engine_dispatches").all()).toEqual(
      [{ run_id: "legacy-run", status: "outcome_unknown" }],
    );
    const job = preparePurge(db);
    await expect(purgeWorkspace(env, identity, job)).rejects.toThrow(
      "durable_engine_dispatch_unresolved",
    );
  });

  it("waits for an in-flight creation acknowledgement before purging either store", async () => {
    const { env, db } = fixture();
    const engine = engineFixture(env);
    const { execution } = await admitDurableExecution(env, identity, submission);
    let acknowledge!: (value: { id: string }) => void;
    let dispatched!: () => void;
    const ready = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    engine.create.mockImplementationOnce(() => {
      dispatched();
      return new Promise((resolve) => {
        acknowledge = resolve;
      });
    });
    const start = startDurableWorkflowEngine(env, execution);
    await ready;
    await expect(startDurableWorkflowEngine(env, execution)).rejects.toThrow();
    expect(engine.create).toHaveBeenCalledTimes(1);
    const job = preparePurge(db);
    await expect(purgeWorkspace(env, identity, job)).rejects.toThrow(
      "durable_engine_dispatch_unresolved",
    );
    expect(engine.deleteBatch).not.toHaveBeenCalled();
    expect(count(db, "control_durable_executions")).toBe(1);
    acknowledge({ id: execution.instance_id });
    await start;
    await purgeWorkspace(env, identity, job);
    expect(engine.deleteBatch).toHaveBeenCalledWith([execution.instance_id]);
    expect(count(db, "control_durable_executions")).toBe(0);
    expect(count(db, "control_durable_engine_dispatches")).toBe(0);
    expect(count(db, "control_deletion_receipts")).toBe(1);
  });

  it("does not recreate an acknowledged instance before the engine starts the canonical run", async () => {
    const { env } = fixture();
    const engine = engineFixture(env);
    const { execution } = await admitDurableExecution(env, identity, submission);
    await startDurableWorkflowEngine(env, execution);
    await startDurableWorkflowEngine(env, execution);
    expect(engine.create).toHaveBeenCalledTimes(1);
    engine.get.mockRejectedValueOnce(new Error("instance.not_found"));
    await expect(startDurableWorkflowEngine(env, execution)).rejects.toThrow("instance.not_found");
    expect(engine.create).toHaveBeenCalledTimes(1);
  });

  it("keeps lost-response uncertainty even when a native instance is visible", async () => {
    const { env, db } = fixture();
    const engine = engineFixture(env);
    engine.create.mockRejectedValue(new Error("provider response contains confidential detail"));
    const { execution } = await admitDurableExecution(env, identity, submission);
    await startDurableWorkflowEngine(env, execution);
    expect(db.prepare("SELECT status FROM control_durable_engine_dispatches").get()!.status).toBe(
      "outcome_unknown",
    );
    const exported = await loadCollection(
      env,
      identity,
      exportCollections.find((c) => c.name === "control_durable_engine_dispatches")!,
    );
    expect(exported).toHaveLength(1);
    expect(JSON.stringify(exported)).not.toContain("confidential");
    const job = preparePurge(db);
    await expect(purgeWorkspace(env, identity, job)).rejects.toThrow(
      "durable_engine_dispatch_unresolved",
    );
    expect(engine.deleteBatch).not.toHaveBeenCalled();
    expect(() => db.exec("DELETE FROM control_durable_engine_dispatches")).toThrow(
      "durable_engine_deletion_required",
    );
    expect(() => db.exec("DELETE FROM control_durable_executions")).toThrow(
      "durable_engine_deletion_required",
    );
    expect(count(db, "control_deletion_receipts")).toBe(0);
  });

  it("fences dispatch admission when quarantine wins the authority race", async () => {
    const { env, db } = fixture();
    const { execution } = await admitDurableExecution(env, identity, submission);
    db.exec("UPDATE workspaces SET status='quarantined'");
    await expect(beginDurableEngineDispatch(env, execution)).rejects.toThrow(
      "durable_dispatch_precondition",
    );
    expect(count(db, "control_durable_engine_dispatches")).toBe(0);
  });

  it("retains partial deletion receipts and retries only unconfirmed identities", async () => {
    const { env, db } = fixture();
    const engine = engineFixture(env);
    await admitDurableExecution(env, identity, submission);
    await admitDurableExecution(env, identity, { ...submission, submissionKey: "second" });
    const job = preparePurge(db);
    engine.deleteBatch.mockImplementationOnce(async (ids) => ({
      deleted: [{ id: ids[0]! }],
      errors: [{ id: ids[1]!, code: 10001, message: "private provider detail" }],
    }));
    await expect(purgeWorkspace(env, identity, job)).rejects.toThrow(
      "durable_engine_deletion_incomplete",
    );
    expect(count(db, "control_durable_executions")).toBe(2);
    const remaining = db
      .prepare("SELECT instance_id FROM control_durable_executions WHERE engine_deleted_at IS NULL")
      .get()!.instance_id as string;
    engine.deleteBatch.mockResolvedValueOnce({
      deleted: [],
      errors: [{ id: remaining, code: 10400, message: "workflows.api.error.instance.not_found" }],
    });
    await purgeWorkspace(env, identity, job);
    expect(engine.deleteBatch).toHaveBeenLastCalledWith([remaining]);
    expect(count(db, "control_durable_executions")).toBe(0);
  });

  it("preserves confirmed native deletion when final D1 cleanup rolls back", async () => {
    const { env, db } = fixture();
    const engine = engineFixture(env);
    await admitDurableExecution(env, identity, submission);
    const job = preparePurge(db);
    db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON control_deletion_receipts
      BEGIN SELECT RAISE(ABORT,'injected_final_failure'); END;`);
    await expect(purgeWorkspace(env, identity, job)).rejects.toThrow("injected_final_failure");
    expect(count(db, "control_durable_executions")).toBe(1);
    expect(count(db, "control_deletion_receipts")).toBe(0);
    expect(
      db.prepare("SELECT engine_deleted_at FROM control_durable_executions").get()!
        .engine_deleted_at,
    ).not.toBeNull();
    db.exec("DROP TRIGGER fail_receipt");
    await purgeWorkspace(env, identity, job);
    expect(engine.deleteBatch).toHaveBeenCalledTimes(1);
    expect(count(db, "control_deletion_receipts")).toBe(1);
  });

  it("rolls back final cleanup if the job lease changes after native deletion", async () => {
    const { env, db } = fixture();
    const engine = engineFixture(env);
    await admitDurableExecution(env, identity, submission);
    const job = preparePurge(db);
    const batch = env.DB.batch.bind(env.DB);
    let calls = 0;
    vi.spyOn(env.DB, "batch").mockImplementation((statements) => {
      if (++calls === 2)
        db.exec(
          "UPDATE control_data_jobs SET lease_owner='replacement',lease_expires_at='2999-01-01T00:00:00Z'",
        );
      return batch(statements);
    });
    await expect(purgeWorkspace(env, identity, job)).rejects.toThrow("NOT NULL");
    expect(count(db, "control_durable_executions")).toBe(1);
    expect(count(db, "control_deletion_receipts")).toBe(0);
    expect(count(db, "workspaces")).toBe(1);
    expect(engine.deleteBatch).toHaveBeenCalledTimes(1);
    await expect(purgeWorkspace(env, identity, job)).rejects.toThrow(
      "workspace_purge_authority_revoked",
    );
    await purgeWorkspace(env, identity, { ...job, lease_owner: "replacement" });
    expect(engine.deleteBatch).toHaveBeenCalledTimes(1);
    expect(count(db, "workspaces")).toBe(0);
  });

  it("retries response loss with exact not-found evidence and retains scope isolation", async () => {
    const { env, db } = fixture();
    const engine = engineFixture(env);
    const { execution } = await admitDurableExecution(env, identity, submission);
    const job = preparePurge(db);
    // A second tenant is deliberately outside the target purge.
    const columns = db
      .prepare("PRAGMA table_info(control_durable_executions)")
      .all()
      .map((row) => row.name as string);
    const replacements: Record<string, string> = {
      run_id: "'other-run'",
      instance_id: "'other-instance'",
      workflow_intent_id: "'other-intent'",
      workspace_id: "'other-workspace'",
    };
    db.exec(
      `INSERT INTO control_durable_executions (${columns.join(",")}) SELECT ${columns.map((c) => replacements[c] ?? c).join(",")} FROM control_durable_executions`,
    );
    engine.deleteBatch.mockRejectedValueOnce(new Error("confidential provider response"));
    await expect(purgeWorkspace(env, identity, job)).rejects.toThrow(
      "durable_engine_deletion_unconfirmed",
    );
    expect(count(db, "control_deletion_receipts")).toBe(0);
    engine.deleteBatch.mockResolvedValueOnce({
      deleted: [],
      errors: [
        {
          id: execution.instance_id,
          code: 10400,
          message: "workflows.api.error.instance.not_found",
        },
      ],
    });
    await purgeWorkspace(env, identity, job);
    expect(engine.deleteBatch.mock.calls).toEqual([
      [[execution.instance_id]],
      [[execution.instance_id]],
    ]);
    expect(
      db.prepare("SELECT workspace_id,engine_deleted_at FROM control_durable_executions").all(),
    ).toEqual([{ workspace_id: "other-workspace", engine_deleted_at: null }]);
  });

  it.each(["foreign", "duplicate", "missing", "invalid_error"])(
    "rejects %s native results without a deletion receipt",
    async (kind) => {
      const { env, db } = fixture();
      const engine = engineFixture(env);
      const { execution } = await admitDurableExecution(env, identity, submission);
      const job = preparePurge(db);
      const id = execution.instance_id;
      engine.deleteBatch.mockResolvedValueOnce({
        deleted:
          kind === "foreign" ? [{ id: "foreign" }] : kind === "duplicate" ? [{ id }, { id }] : [],
        errors: kind === "invalid_error" ? [{ id }] : [],
      } as Awaited<ReturnType<NonNullable<NonNullable<Env["DURABLE_WORKFLOWS"]>["deleteBatch"]>>>);
      await expect(purgeWorkspace(env, identity, job)).rejects.toThrow(
        "durable_engine_deletion_invalid_result",
      );
      expect(
        db.prepare("SELECT engine_deleted_at FROM control_durable_executions").get()!
          .engine_deleted_at,
      ).toBeNull();
      expect(count(db, "control_deletion_receipts")).toBe(0);
    },
  );

  it("yields a bounded successful page without consuming the failure budget", async () => {
    const { env, db } = fixture();
    const engine = engineFixture(env);
    env.OPERLOOM_RETAINED_DATA_ENABLED = "true";
    for (let i = 0; i < 26; i++) {
      await admitDurableExecution(env, identity, { ...submission, submissionKey: `page-${i}` });
      db.exec("UPDATE control_runs SET status='cancelled' WHERE status='queued'");
    }
    preparePurge(db);
    expect(await processDataLifecycleJobs(env)).toMatchObject({ completed: 0, failed: 0 });
    expect(engine.deleteBatch.mock.calls[0]![0]).toHaveLength(25);
    expect(
      db.prepare("SELECT status,attempt_count,lease_owner FROM control_data_jobs").get(),
    ).toMatchObject({ status: "queued", attempt_count: 0, lease_owner: null });
    expect(count(db, "control_durable_executions")).toBe(26);
    expect(await processDataLifecycleJobs(env)).toMatchObject({ completed: 1, failed: 0 });
    expect(engine.deleteBatch.mock.calls[1]![0]).toHaveLength(1);
    expect(count(db, "control_durable_executions")).toBe(0);
  });

  it("blocks external deletion under an export fence and when the native binding is unavailable", async () => {
    const { env, db } = fixture();
    const engine = engineFixture(env);
    await admitDurableExecution(env, identity, submission);
    const job = preparePurge(db);
    db.exec(`INSERT INTO control_workspace_write_fences (workspace_id,job_id,status,lease_owner,lease_expires_at,acquired_at,updated_at)
      VALUES ('w','export','active','owner','2999-01-01T00:00:00Z','now','now')`);
    await expect(purgeWorkspace(env, identity, job)).rejects.toThrow(
      "workspace_purge_authority_revoked",
    );
    expect(engine.deleteBatch).not.toHaveBeenCalled();
    db.exec("DELETE FROM control_workspace_write_fences");
    delete env.DURABLE_WORKFLOWS;
    await expect(purgeDurableEngines(env, "w")).rejects.toThrow(
      "durable_engine_deletion_unavailable",
    );
    expect(count(db, "control_durable_executions")).toBe(1);
  });
});

describe("bounded durable recovery", () => {
  it("recovers never-created pending instances but never recreates started instances after a missing-engine error", async () => {
    const { env } = fixture();
    const engine = engineFixture(env);
    engine.get.mockRejectedValue(new Error("instance.not_found"));
    const pending = await admitDurableExecution(env, identity, submission);
    expect(await recoverDurableExecutions(env)).toMatchObject({ claimed: 1, deferred: 0 });
    expect(engine.create).toHaveBeenCalledWith({
      id: pending.execution.instance_id,
      params: { runId: pending.execution.run_id },
    });
    const started = await setupRun(env, { submissionKey: "started" });
    expect(await recoverDurableExecutions(env)).toMatchObject({ claimed: 1, deferred: 1 });
    await expect(
      startDurableWorkflowEngine(env, {
        ...pending.execution,
        run_id: started,
        instance_id: started,
      }),
    ).rejects.toThrow();
    expect(engine.create).toHaveBeenCalledTimes(1);
  });

  it("closes a deadline-expired startup without dispatching work", async () => {
    const { db, env } = fixture();
    const engine = engineFixture(env, "terminated");
    const { execution } = await admitDurableExecution(env, identity, submission);
    // Seed a historical immutable deadline, as if this row had survived a long outage.
    db.exec(
      "DROP TRIGGER immutable_durable_execution; UPDATE control_durable_executions SET deadline='2000-01-01T00:00:00.000Z'",
    );
    expect(await recoverDurableExecutions(env)).toMatchObject({ closed: 1, deferred: 0 });
    expect(
      db
        .prepare(
          "SELECT status,json_extract(data_json,'$.error.code') code FROM control_runs WHERE id=?",
        )
        .get(execution.run_id),
    ).toMatchObject({ status: "failed", code: "durable_deadline_exceeded" });
    expect(
      db.prepare("SELECT status,recovery_next_at FROM control_durable_executions").get(),
    ).toMatchObject({ status: "closed", recovery_next_at: null });
    expect(engine.create).not.toHaveBeenCalled();
    expect(await recoverDurableExecutions(env)).toMatchObject({ selected: 0 });
  });

  it.each(["errored", "terminated", "complete"])(
    "records an engine %s without inventing a canonical success or losing uncertain effects",
    async (status) => {
      const { db, env } = fixture();
      const engine = engineFixture(env, status);
      const runId = await setupRun(env);
      const completed = await activeClaim(env, runId);
      await finishDurableStep(
        env,
        identity,
        runId,
        completed.stepId,
        completed.attemptId,
        complete,
      );
      const interrupted = await activeClaim(env, runId, { key: "write" });
      expect(await recoverDurableExecutions(env)).toMatchObject({ closed: 1, deferred: 0 });
      expect(db.prepare("SELECT status FROM control_runs WHERE id=?").get(runId)?.status).toBe(
        "blocked",
      );
      expect(
        db.prepare("SELECT status FROM control_durable_steps WHERE id=?").get(completed.stepId)
          ?.status,
      ).toBe("completed");
      expect(
        db
          .prepare("SELECT status,error_code FROM control_durable_step_attempts WHERE id=?")
          .get(interrupted.attemptId),
      ).toMatchObject({ status: "outcome_unknown", error_code: "durable_execution_stopped" });
      expect(count(db, "control_durable_step_outcomes")).toBe(2);
      const before = count(db, "control_plane_events");
      dueAgain(db);
      await recoverDurableExecutions(env);
      expect(count(db, "control_plane_events")).toBe(before);
      expect(engine.create).not.toHaveBeenCalled();
      expect(engine.terminate).not.toHaveBeenCalled();
    },
  );

  it("rechecks revoked authority inside the closing transaction", async () => {
    const { db, env } = fixture();
    const runId = await setupRun(env);
    const row = (await claimDurableRecovery(env, runId))!;
    db.exec("UPDATE memberships SET status='revoked'");
    const original = env.DB.batch.bind(env.DB);
    env.DB.batch = async (statements) => {
      db.exec("UPDATE memberships SET status='active'");
      return original(statements);
    };
    await expect(closeDurableRecovery(env, row, "durable_authority_revoked")).rejects.toThrow();
    expect(db.prepare("SELECT status FROM control_runs").get()?.status).toBe("running");
  });

  it("closes revoked work and retries termination without ever restoring execution authority", async () => {
    const { db, env } = fixture();
    const engine = engineFixture(env);
    const runId = await setupRun(env);
    await activeClaim(env, runId);
    db.exec("UPDATE memberships SET status='revoked'");
    engine.terminate.mockRejectedValueOnce(new Error("private-provider-response"));
    expect(await recoverDurableExecutions(env)).toMatchObject({ closed: 1, deferred: 1 });
    expect(db.prepare("SELECT status FROM control_runs").get()?.status).toBe("blocked");
    expect(
      db.prepare("SELECT recovery_error_code FROM control_durable_executions").get()
        ?.recovery_error_code,
    ).toBe("durable_recovery_retry");
    dueAgain(db);
    await recoverDurableExecutions(env);
    dueAgain(db);
    await recoverDurableExecutions(env);
    expect(engine.terminate).toHaveBeenCalledTimes(2);
    expect(engine.create).not.toHaveBeenCalled();
    expect(
      db
        .prepare("SELECT recovery_next_at,recovery_engine_status FROM control_durable_executions")
        .get(),
    ).toMatchObject({ recovery_next_at: null, recovery_engine_status: "terminated" });
  });

  it("preserves a cancellation that races engine inspection and closes its outstanding attempts", async () => {
    const { db, env } = fixture();
    const engine = engineFixture(env);
    const runId = await setupRun(env);
    await activeClaim(env, runId);
    engine.status.mockImplementationOnce(async () => {
      db.exec("UPDATE control_runs SET status='cancelled'");
      return { status: "errored" };
    });
    await recoverDurableExecutions(env);
    expect(db.prepare("SELECT status FROM control_runs").get()?.status).toBe("cancelled");
    expect(db.prepare("SELECT status FROM control_durable_step_attempts").get()?.status).toBe(
      "outcome_unknown",
    );
    expect(
      db.prepare("SELECT 1 FROM control_plane_events WHERE id=?").get(`${runId}:terminal`),
    ).toBeUndefined();
  });

  it("rolls back canonical closure and unknown outcomes together on a late event failure", async () => {
    const { db, env } = fixture();
    engineFixture(env, "errored");
    const runId = await setupRun(env);
    await activeClaim(env, runId);
    db.exec(
      "CREATE TRIGGER fail_recovery BEFORE INSERT ON control_plane_events WHEN NEW.type='workflow.step.finished' BEGIN SELECT RAISE(ABORT,'late'); END",
    );
    expect(await recoverDurableExecutions(env)).toMatchObject({ deferred: 1 });
    expect(db.prepare("SELECT status FROM control_runs").get()?.status).toBe("running");
    expect(db.prepare("SELECT status FROM control_workflow_intents").get()?.status).toBe("running");
    expect(db.prepare("SELECT status FROM control_durable_step_attempts").get()?.status).toBe(
      "running",
    );
    expect(count(db, "control_durable_step_outcomes")).toBe(0);
    db.exec("DROP TRIGGER fail_recovery");
    dueAgain(db);
    expect(await recoverDurableExecutions(env)).toMatchObject({ closed: 1 });
  });

  it("leases concurrent sweeps and rejects stale lease publication", async () => {
    const { db, env } = fixture();
    const engine = engineFixture(env);
    const runId = await setupRun(env);
    const results = await Promise.all([
      recoverDurableExecutions(env),
      recoverDurableExecutions(env),
    ]);
    expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(1);
    expect(engine.status).toHaveBeenCalledTimes(1);
    dueAgain(db);
    const row = (await claimDurableRecovery(env, runId))!;
    db.exec(
      "UPDATE control_durable_executions SET recovery_lease_expires_at='2000-01-01T00:00:00.000Z'",
    );
    dueAgain(db);
    const replacement = (await claimDurableRecovery(env, runId))!;
    await expect(closeDurableRecovery(env, row, "durable_engine_errored")).rejects.toThrow();
    await releaseDurableRecovery(env, row, {
      done: true,
      engineStatus: "complete",
      errorCode: null,
    });
    expect(
      db.prepare("SELECT recovery_lease_id FROM control_durable_executions").get()
        ?.recovery_lease_id,
    ).toBe(replacement.recovery_lease_id);
    expect(db.prepare("SELECT status FROM control_runs").get()?.status).toBe("running");
  });

  it("rotates failed inspections so the first sixteen rows cannot starve untouched submissions", async () => {
    const { db, env } = fixture();
    const engine = engineFixture(env);
    engine.get.mockRejectedValue(new Error("private-provider-response"));
    engine.create.mockRejectedValue(new Error("private-provider-response"));
    for (let i = 0; i < 18; i++)
      await admitDurableExecution(env, identity, {
        ...submission,
        submissionKey: `backlog-${i}`,
        maxActiveRuns: 100,
      });
    expect(await recoverDurableExecutions(env)).toMatchObject({
      selected: 16,
      claimed: 16,
      deferred: 16,
    });
    expect(await recoverDurableExecutions(env)).toMatchObject({
      selected: 2,
      claimed: 2,
      deferred: 2,
    });
    expect(await recoverDurableExecutions(env)).toMatchObject({ selected: 0 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM control_durable_executions WHERE recovery_attempts=1 AND recovery_error_code='durable_recovery_retry'",
        )
        .get()?.n,
    ).toBe(18);
  });

  it("respects workspace export fences and resumes after the fence is released", async () => {
    const { db, env } = fixture();
    const engine = engineFixture(env, "errored");
    await setupRun(env);
    db.exec(`INSERT INTO control_workspace_write_fences (workspace_id,job_id,status,lease_owner,lease_expires_at,acquired_at,updated_at)
      VALUES ('w','export','active','owner','2999-01-01T00:00:00Z','now','now')`);
    expect(await recoverDurableExecutions(env)).toMatchObject({
      selected: 0,
      claimed: 0,
      failed: 0,
    });
    expect(engine.get).not.toHaveBeenCalled();
    db.exec("DELETE FROM control_workspace_write_fences");
    expect(await recoverDurableExecutions(env)).toMatchObject({ closed: 1 });
  });
});

describe("durable execution persistence", () => {
  it("recovers pending startup using one engine identity and accepts a lost create response only after inspection", async () => {
    const { env } = fixture();
    const { execution } = await admitDurableExecution(env, identity, submission);
    const create = vi.fn(async () => {
      throw new Error("Response lost");
    });
    const status = vi.fn(async () => ({ status: "running" }));
    env.DURABLE_WORKFLOWS = { create, get: vi.fn(async () => ({ status, async terminate() {} })) };
    await startDurableWorkflowEngine(env, execution);
    await recoverDurableExecutions(env);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenLastCalledWith({
      id: execution.instance_id,
      params: { runId: execution.run_id },
    });
    status.mockResolvedValueOnce({ status: "unknown" });
    await expect(startDurableWorkflowEngine(env, execution)).rejects.toThrow("Response lost");
  });
  it("validates the definition again when loading an engine-cached result reference", async () => {
    const { env } = fixture(),
      runId = await setupRun(env),
      claim = await activeClaim(env, runId);
    await finishDurableStep(env, identity, runId, claim.stepId, claim.attemptId, complete);
    expect(await loadDurableStepOutput(env, identity, runId, claim.stepId, step)).toEqual(
      complete.output,
    );
    await expect(
      loadDurableStepOutput(env, identity, runId, claim.stepId, {
        ...step,
        payload: { documentId: "changed" },
      }),
    ).rejects.toMatchObject({ code: "durable_step_conflict" });
  });

  it("publishes one terminal outcome and event under duplicate completion and rejects changed results", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env);
    const outcome = { ok: true as const, output: { capacity: 7 } };
    await Promise.all([
      completeDurableExecution(env, identity, runId, outcome, pins),
      completeDurableExecution(env, identity, runId, outcome, pins),
    ]);
    await completeDurableExecution(env, identity, runId, outcome, pins);
    expect(db.prepare("SELECT status FROM control_runs WHERE id=?").get(runId)?.status).toBe(
      "completed",
    );
    expect(
      db.prepare("SELECT COUNT(*) n FROM control_plane_events WHERE id=?").get(`${runId}:terminal`)
        ?.n,
    ).toBe(1);
    await expect(
      completeDurableExecution(env, identity, runId, { ok: true, output: { capacity: 8 } }, pins),
    ).rejects.toMatchObject({ code: "durable_outcome_conflict" });
  });
  it("rolls back terminal status and startup closure if event publication fails", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env);
    db.exec(
      "CREATE TRIGGER fail_terminal BEFORE INSERT ON control_plane_events BEGIN SELECT RAISE(ABORT,'late_event_failure'); END",
    );
    await expect(
      completeDurableExecution(env, identity, runId, { ok: true, output: {} }, pins),
    ).rejects.toThrow("late_event_failure");
    expect(db.prepare("SELECT status FROM control_runs WHERE id=?").get(runId)?.status).toBe(
      "running",
    );
    expect(
      db.prepare("SELECT status FROM control_durable_executions WHERE run_id=?").get(runId)?.status,
    ).toBe("started");
  });
  it("cannot publish terminal output after a cancellation race", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env),
      batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce((statements) => {
      db.prepare("UPDATE control_runs SET status='cancelled' WHERE id=?").run(runId);
      return batch(statements);
    });
    await expect(
      completeDurableExecution(env, identity, runId, { ok: true, output: { capacity: 7 } }, pins),
    ).rejects.toThrow();
    expect(db.prepare("SELECT status FROM control_runs WHERE id=?").get(runId)?.status).toBe(
      "cancelled",
    );
    expect(
      db.prepare("SELECT 1 FROM control_plane_events WHERE id=?").get(`${runId}:terminal`),
    ).toBeUndefined();
  });

  it("rechecks kill switches for cached steps and fences agent upgrades while a run is active", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env),
      claim = await activeClaim(env, runId);
    await finishDurableStep(env, identity, runId, claim.stepId, claim.attemptId, complete);
    expect(() => db.exec("UPDATE agents SET runtime_revision=1")).toThrow(
      "agent_runtime_revision_busy",
    );
    db.exec(`INSERT INTO control_kill_switches (id,user_id,workspace_id,scope_kind,scope_id,reason,created_by_user_id,created_at,updated_at)
      VALUES ('stop','u','w','pack','document-review','Paused','u','now','now')`);
    await expect(claimDurableStep(env, identity, runId, step)).rejects.toMatchObject({
      code: "durable_execution_fenced",
    });
    db.exec("UPDATE control_kill_switches SET enabled=0; UPDATE memberships SET status='revoked'");
    await expect(claimDurableStep(env, identity, runId, step)).rejects.toMatchObject({
      code: "durable_authority_revoked",
    });
  });
  it("checks database time before admitting an already expired lease", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2000-01-01T00:00:00Z"));
    await expect(claimDurableStep(env, identity, runId, step)).rejects.toMatchObject({
      code: "durable_step_admission_denied",
    });
    expect(count(db, "control_durable_steps")).toBe(0);
    expect(count(db, "control_durable_step_attempts")).toBe(0);
  });
  it("admits one logical run under concurrent submissions and rejects changed-content replay", async () => {
    const { env, db } = fixture();
    const results = await Promise.all([
      admitDurableExecution(env, identity, submission),
      admitDurableExecution(env, identity, submission),
    ]);
    expect(results.filter((r) => r.accepted)).toHaveLength(1);
    expect(results[0].execution.run_id).toBe(results[1].execution.run_id);
    expect(results[0].execution.instance_id).toBe(results[0].execution.run_id);
    expect(results[0].execution.status).toBe("pending");
    for (const table of [
      "control_durable_executions",
      "control_runs",
      "control_workflow_intents",
      "control_plane_events",
    ])
      expect(count(db, table)).toBe(1);
    await expect(
      admitDurableExecution(env, identity, { ...submission, input: { text: "Changed" } }),
    ).rejects.toMatchObject({ code: "durable_submission_conflict" });
  });
  it("rolls back the whole admission after a late failure or membership revocation", async () => {
    const { env, db } = fixture();
    db.exec(
      "CREATE TRIGGER fail_event BEFORE INSERT ON control_plane_events BEGIN SELECT RAISE(ABORT,'late'); END",
    );
    await expect(admitDurableExecution(env, identity, submission)).rejects.toMatchObject({
      code: "durable_admission_denied",
    });
    for (const table of [
      "control_durable_executions",
      "control_runs",
      "control_workflow_intents",
      "control_plane_events",
    ])
      expect(count(db, table)).toBe(0);
    db.exec("DROP TRIGGER fail_event");
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce((statements) => {
      db.exec("UPDATE memberships SET status='revoked'");
      return batch(statements);
    });
    await expect(admitDurableExecution(env, identity, submission)).rejects.toMatchObject({
      code: "durable_admission_denied",
    });
    expect(count(db, "control_runs")).toBe(0);
  });
  it("pins the handler and configuration and never restarts a missing submission", async () => {
    const { env, db } = fixture();
    const { execution } = await admitDurableExecution(env, identity, submission);
    await expect(
      startDurableExecution(env, identity, execution.run_id, { ...pins, workflowVersion: "2" }),
    ).rejects.toMatchObject({ code: "durable_handler_incompatible" });
    env.OPENROUTER_MODEL = "openai/gpt-4.1-mini";
    await expect(
      startDurableExecution(env, identity, execution.run_id, pins),
    ).rejects.toMatchObject({ code: "durable_configuration_changed" });
    delete env.OPENROUTER_MODEL;
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce((statements) => {
      // Simulate historical corruption; normal deletion now requires native cleanup.
      db.exec("DROP TRIGGER durable_engine_purge_guard; DELETE FROM control_durable_executions");
      return batch(statements);
    });
    await expect(
      startDurableExecution(env, identity, execution.run_id, pins),
    ).rejects.toMatchObject({ code: "durable_authority_revoked" });
    expect(db.prepare("SELECT status FROM control_runs").get()!.status).toBe("queued");
  });
  it("reuses completed step output after reconstruction and does not grant execution twice", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env);
    const first = await activeClaim(env, runId);
    await finishDurableStep(env, identity, runId, first.stepId, first.attemptId, complete);
    const second = await activeClaim(env, runId, {
      key: "allocate",
      payload: { documentId: "two" },
    });
    await finishDurableStep(env, identity, runId, second.stepId, second.attemptId, {
      status: "completed",
      output: { capacity: 3 },
    });
    expect(await claimDurableStep(env, identity, runId, step)).toEqual({
      execute: false,
      stepId: first.stepId,
      output: { capacity: 7 },
    });
    expect(count(db, "control_durable_step_attempts")).toBe(2);
    await expect(
      claimDurableStep(env, identity, runId, { ...step, version: "2" }),
    ).rejects.toMatchObject({ code: "durable_step_conflict" });
    await expect(
      claimDurableStep(
        env,
        { ...identity, scope: { userId: "other", workspaceId: "w" } },
        runId,
        step,
      ),
    ).rejects.toMatchObject({ code: "durable_authority_revoked" });
  });
  it("serializes racing step claims and enforces the persisted step bound", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env, { maxSteps: 1 });
    const outcomes = await Promise.allSettled([
      claimDurableStep(env, identity, runId, step),
      claimDurableStep(env, identity, runId, step),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(count(db, "control_durable_step_attempts")).toBe(1);
    await expect(
      claimDurableStep(env, identity, runId, { ...step, key: "other" }),
    ).rejects.toMatchObject({ code: "durable_step_admission_denied" });
    expect(count(db, "control_durable_steps")).toBe(1);
  });
  it("atomically publishes one immutable outcome and rejects conflicting or invalid output", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env),
      claim = await activeClaim(env, runId);
    await expect(
      finishDurableStep(env, identity, runId, claim.stepId, claim.attemptId, {
        status: "completed",
        output: { private: "invalid" },
      }),
    ).rejects.toThrow();
    expect(count(db, "control_durable_step_outcomes")).toBe(0);
    db.exec(
      "CREATE TRIGGER fail_event BEFORE INSERT ON control_plane_events WHEN NEW.type='workflow.step.finished' BEGIN SELECT RAISE(ABORT,'late'); END",
    );
    await expect(
      finishDurableStep(env, identity, runId, claim.stepId, claim.attemptId, complete),
    ).rejects.toMatchObject({ code: "durable_step_publication_denied" });
    expect(count(db, "control_durable_step_outcomes")).toBe(0);
    expect(
      db.prepare("SELECT status,output_json FROM control_durable_step_attempts").get(),
    ).toMatchObject({ status: "running", output_json: null });
    db.exec("DROP TRIGGER fail_event");
    await Promise.all([
      finishDurableStep(env, identity, runId, claim.stepId, claim.attemptId, complete),
      finishDurableStep(env, identity, runId, claim.stepId, claim.attemptId, complete),
    ]);
    expect(count(db, "control_durable_step_outcomes")).toBe(1);
    expect(
      db
        .prepare("SELECT COUNT(*) n FROM control_plane_events WHERE type='workflow.step.finished'")
        .get()!.n,
    ).toBe(1);
    await expect(
      finishDurableStep(env, identity, runId, claim.stepId, claim.attemptId, {
        status: "completed",
        output: { capacity: 99 },
      }),
    ).rejects.toMatchObject({ code: "durable_step_publication_denied" });
  });
  it("records an unsafe interrupted attempt as unknown without re-executing it", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env),
      claim = await activeClaim(env, runId);
    expire(db, claim.stepId);
    await expect(claimDurableStep(env, identity, runId, step)).rejects.toMatchObject({
      code: "durable_step_requires_reconciliation",
    });
    expect(count(db, "control_durable_step_attempts")).toBe(1);
    expect(
      db.prepare("SELECT status,error_code FROM control_durable_step_attempts").get(),
    ).toMatchObject({ status: "outcome_unknown", error_code: "step_interrupted" });
    await expect(
      finishDurableStep(env, identity, runId, claim.stepId, claim.attemptId, complete),
    ).rejects.toMatchObject({ code: "durable_step_publication_denied" });
  });
  it("gives declared-safe retries fresh attempt identities and rejects old or excess attempts", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env),
      retry = { ...step, replaySafe: true, maxAttempts: 2 };
    const first = await activeClaim(env, runId, retry);
    await expect(claimDurableStep(env, identity, runId, retry)).rejects.toMatchObject({
      code: "durable_step_in_progress",
    });
    expire(db, first.stepId);
    const second = await activeClaim(env, runId, retry);
    expect(second.stepId).toBe(first.stepId);
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(second.attempt).toBe(2);
    await expect(
      finishDurableStep(env, identity, runId, first.stepId, first.attemptId, complete),
    ).rejects.toMatchObject({ code: "durable_step_attempt_superseded" });
    expect(
      db
        .prepare("SELECT status FROM control_durable_step_attempts WHERE id=?")
        .get(first.attemptId)!.status,
    ).toBe("outcome_unknown");
    expire(db, second.stepId);
    await expect(claimDurableStep(env, identity, runId, retry)).rejects.toMatchObject({
      code: "durable_step_requires_reconciliation",
    });
    expect(count(db, "control_durable_step_attempts")).toBe(2);
  });
  it("fences publication if cancellation races its transaction", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env),
      claim = await activeClaim(env, runId);
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce((statements) => {
      db.exec("UPDATE control_runs SET status='cancelled'");
      return batch(statements);
    });
    await expect(
      finishDurableStep(env, identity, runId, claim.stepId, claim.attemptId, complete),
    ).rejects.toMatchObject({ code: "durable_step_publication_denied" });
    expect(count(db, "control_durable_step_outcomes")).toBe(0);
    expect(db.prepare("SELECT status FROM control_durable_steps").get()!.status).toBe("running");
    await expect(claimDurableStep(env, identity, runId, step)).rejects.toMatchObject({
      code: "durable_execution_fenced",
    });
    expect(db.prepare("SELECT status FROM control_durable_executions").get()!.status).toBe(
      "closed",
    );
    await expect(startDurableExecution(env, identity, runId, pins)).rejects.toMatchObject({
      code: "durable_execution_fenced",
    });
  });
  it("fails closed if an attempt vanishes before publication instead of partially writing the result", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env),
      claim = await activeClaim(env, runId);
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce((statements) => {
      db.prepare("DELETE FROM control_durable_step_attempts WHERE id=?").run(claim.attemptId);
      return batch(statements);
    });
    await expect(
      finishDurableStep(env, identity, runId, claim.stepId, claim.attemptId, complete),
    ).rejects.toMatchObject({ code: "durable_step_publication_denied" });
    expect(count(db, "control_durable_step_outcomes")).toBe(0);
    expect(db.prepare("SELECT status FROM control_durable_steps").get()!.status).toBe("running");
  });
  it("exports, fences, recovers and purges the durable records through the existing lifecycle", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env),
      claim = await activeClaim(env, runId);
    const engine = engineFixture(env);
    await finishDurableStep(env, identity, runId, claim.stepId, claim.attemptId, complete);
    const tables = [
      "control_durable_executions",
      "control_durable_steps",
      "control_durable_step_attempts",
      "control_durable_step_outcomes",
    ];
    for (const table of tables)
      expect(
        await loadCollection(env, identity, exportCollections.find((c) => c.name === table)!),
      ).toHaveLength(1);
    db.exec(`INSERT INTO control_workspace_write_fences (workspace_id,job_id,status,lease_owner,lease_expires_at,acquired_at,updated_at)
      VALUES ('w','export','active','owner','2999-01-01T00:00:00Z','now','now')`);
    await expect(
      claimDurableStep(env, identity, runId, { ...step, key: "blocked" }),
    ).rejects.toMatchObject({ code: "workspace_export_in_progress" });
    db.exec(
      "DELETE FROM control_workspace_write_fences; UPDATE workspaces SET status='quarantined'",
    );
    await expect(requireDurableExecutionAuthority(env, identity, runId)).rejects.toMatchObject({
      code: "durable_authority_revoked",
    });
    db.exec("UPDATE workspaces SET status='active'");
    expect(await claimDurableStep(env, identity, runId, step)).toMatchObject({
      execute: false,
      output: { capacity: 7 },
    });
    db.exec(`UPDATE workspaces SET status='purging',purge_after='2000-01-01T00:00:00Z';
      INSERT INTO control_data_jobs (id,user_id,workspace_id,kind,status,cursor_json,created_by_user_id,created_at,updated_at)
      VALUES ('purge','u','w','purge','running','{"phase":"objects_deleted"}','u','now','now')`);
    await purgeWorkspace(
      env,
      identity,
      db
        .prepare("SELECT * FROM control_data_jobs WHERE id='purge'")
        .get() as unknown as ControlDataJobRow,
    );
    for (const table of tables) expect(count(db, table)).toBe(0);
    expect(engine.deleteBatch).toHaveBeenCalledWith([runId]);
  });
});

const attemptAuthority = async (
  env: Env,
  runId: string,
  claim: { stepId: string; attemptId: string },
): Promise<DurableAttemptAuthority> => ({
  ...pins,
  runId,
  stepId: claim.stepId,
  attemptId: claim.attemptId,
  configurationHash: (await requireDurableExecutionAuthority(env, identity, runId))
    .configuration_hash,
});

describe("document review simulation workflow", () => {
  it("runs the package's durable preparation and simulation steps", async () => {
    const { env, db } = fixture();
    const runtime = resolvePackRuntime("document-review", "1.0.0");
    if (!runtime.runnable) throw new Error("Expected package");
    const workflow = runtime.controlPlane.workflows.find(
      (item) => item.type === "document-review.simulate",
    )!;
    const { execution } = await admitDurableExecution(env, identity, {
      ...submission,
      workflowType: workflow.type,
      definitionHash: await durableWorkflowDefinitionHash(runtime, workflow),
      input: { documentId: "guide", text: "Original document" },
    });
    await expect(
      runDurableWorkflow(env, execution.run_id, {
        do: async (_name, _options, callback) => callback(),
        sleepUntil: async () => {},
      }),
    ).resolves.toEqual({ runId: execution.run_id });
    expect(count(db, "control_state_entries")).toBe(2);
  });
});
const allocation = { namespace: "capacity", kind: "pool", key: "one" };
const stateCommit = {
  idempotencyKey: "allocate",
  reads: [{ ...allocation, version: 0 }],
  writes: [{ ...allocation, schemaVersion: 1, data: { capacity: 7 } }],
  entries: [{ id: "effect", type: "effect" as const, data: { capacity: 7 } }],
  events: [{ id: "delivery", type: "capacity.changed", data: { capacity: 7 } }],
};
const statePort = (env: Env, runId: string, durableAttempt?: DurableAttemptAuthority) =>
  createRuntimeStatePort(env, identity, {
    packId: "document-review",
    target: "simulation",
    runId,
    durableAttempt,
    definitions: [
      { namespace: "capacity", kind: "pool", schemaVersion: 1, schema: step.outputSchema },
    ],
  });
const budget = (db: DatabaseSync) =>
  db.prepare("INSERT INTO control_budget_policies VALUES ('w',1,?,'u','now')").run(
    JSON.stringify({
      dailyModelCalls: 20,
      dailyToolCalls: 20,
      dailyTokens: 1000000,
      runModelCalls: 20,
      runToolCalls: 20,
      runTokens: 1000000,
      concurrentOperations: 20,
    }),
  );
const usage = (env: Env, runId: string, durableAttempt?: DurableAttemptAuthority) =>
  reserveRuntimeUsage(env, identity, {
    runId,
    runKind: "workflow",
    packId: "document-review",
    kind: "model",
    operationKey: "observe",
    payload: { text: "Capacity" },
    estimatedInputTokens: 10,
    maxOutputTokens: 20,
    durableAttempt,
  });

describe("durable attempt authority in runtime ports", () => {
  it("fences tool admission and late results while retaining already incurred usage", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env),
      claim = await activeClaim(env, runId);
    budget(db);
    const durableAttempt = await attemptAuthority(env, runId, claim);
    const execute = vi.fn(async () => {
      expire(db, claim.stepId);
      return { ok: true as const, summary: "Observed", output: { capacity: 7 } };
    });
    const invoke = () =>
      executeRuntimeToolBinding({
        env,
        identity,
        binding: {
          id: "document-review.observe",
          description: "Observe capacity",
          inputSchema: { type: "object" },
          outputSchema: step.outputSchema,
          executionModes: ["dry_run"],
          transport: "cloudflare_inline",
          adapterVersion: "1",
          timeoutMs: 1000,
          maxArtifactBytes: 1024,
          policy: {
            reference: "observe",
            adminVisible: false,
            modelVisible: false,
            requiresApproval: false,
            policyEditable: false,
            mutationRisk: "read_only",
          },
          execute,
        },
        toolInput: {},
        context: {
          pack: { id: "document-review", version: "1.0.0" },
          context: { assertReady() {}, snapshot: { id: undefined } },
          signal: new AbortController().signal,
        } as never,
        execution: {
          runId,
          durableAttempt,
          workflowIntentId: "intent",
          toolCallId: "observe",
          packVersion: "1.0.0",
          runtimeVersion: "1.0.0",
          bindingVersion: 1,
          source: "agent-pack",
        },
      });
    expect(await invoke()).toMatchObject({ ok: false, error: { code: "durable_attempt_fenced" } });
    expect(await invoke()).toMatchObject({ ok: false, error: { code: "durable_attempt_fenced" } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT status,kind FROM control_resource_reservations").get()).toMatchObject(
      { status: "settled", kind: "tool" },
    );
  });

  it("fences context capture and publication with the active attempt", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env),
      claim = await activeClaim(env, runId);
    const durableAttempt = await attemptAuthority(env, runId, claim);
    const input = {
      runId,
      runKind: "workflow" as const,
      target: "simulation" as const,
      input: { text: "Observed document" },
      signal: new AbortController().signal,
      durableAttempt,
    };
    await expect(
      captureRuntimeContext(env, identity, { ...input, durableAttempt: undefined }),
    ).rejects.toMatchObject({ code: "context_authority_revoked" });
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce((statements) => {
      expire(db, claim.stepId);
      return batch(statements);
    });
    await expect(captureRuntimeContext(env, identity, input)).rejects.toMatchObject({
      code: "context_authority_revoked",
    });
    expect(count(db, "control_context_snapshots")).toBe(0);
  });
  it("does not return structured output to an expired attempt but retains incurred usage", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env),
      claim = await activeClaim(env, runId);
    budget(db);
    env.OPERLOOM_E2E_MODE = "true";
    env.OPERLOOM_ENVIRONMENT = "local";
    const durableAttempt = await attemptAuthority(env, runId, claim);
    const model = createRuntimeModelPort(env, identity, {
      runId,
      durableAttempt,
      signal: new AbortController().signal,
    });
    const batch = env.DB.batch.bind(env.DB);
    let batches = 0;
    vi.spyOn(env.DB, "batch").mockImplementation((statements) => {
      if (++batches === 2) expire(db, claim.stepId);
      return batch(statements);
    });
    await expect(
      model.structured({
        idempotencyKey: "summary",
        prompt: "Observe",
        outputSchema: { type: "object", properties: { summary: { type: "string" } } },
      }),
    ).rejects.toMatchObject({ code: "durable_attempt_fenced" });
    expect(
      db.prepare("SELECT status,usage_source FROM control_resource_reservations").get(),
    ).toMatchObject({ status: "settled", usage_source: "fixture" });
  });

  it("rejects missing, wrong-run and mismatched handler authority before state or usage admission", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env),
      claim = await activeClaim(env, runId);
    budget(db);
    const authority = await attemptAuthority(env, runId, claim);
    const unbound = await statePort(env, runId);
    await expect(unbound.commit(stateCommit)).rejects.toMatchObject({ code: "state_conflict" });
    await expect(usage(env, runId)).rejects.toMatchObject({ code: "durable_attempt_fenced" });
    await expect(statePort(env, "different-run", authority)).rejects.toMatchObject({
      code: "durable_attempt_fenced",
    });
    for (const changes of [
      { definitionHash: "b".repeat(64) },
      { configurationHash: "b".repeat(64) },
      { workflowVersion: "2" },
      { runtimeVersion: "2" },
      { attemptId: "another" },
      { stepId: "another" },
    ]) {
      const invalid = { ...authority, ...changes },
        port = await statePort(env, runId, invalid);
      await expect(port.commit(stateCommit)).rejects.toMatchObject({ code: "state_conflict" });
      await expect(usage(env, runId, invalid)).rejects.toMatchObject({
        code: "durable_attempt_fenced",
      });
    }
    expect(count(db, "control_state_records")).toBe(0);
    expect(count(db, "control_resource_reservations")).toBe(0);
  });
  it("rolls back all state, evidence and outbox writes when an attempt expires before the transaction", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env),
      claim = await activeClaim(env, runId);
    const port = await statePort(env, runId, await attemptAuthority(env, runId, claim));
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce((statements) => {
      expire(db, claim.stepId);
      return batch(statements);
    });
    await expect(port.commit(stateCommit)).rejects.toMatchObject({ code: "state_conflict" });
    for (const table of [
      "control_state_records",
      "control_state_commits",
      "control_state_entries",
      "control_state_outbox",
    ])
      expect(count(db, table)).toBe(0);
  });
  it("reuses state receipts with the replacement attempt but fences captured reads and replays", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env),
      claim = await activeClaim(env, runId, { replaySafe: true, maxAttempts: 2 });
    const port = await statePort(env, runId, await attemptAuthority(env, runId, claim));
    const receipt = await port.commit(stateCommit);
    expire(db, claim.stepId);
    const replacement = await activeClaim(env, runId, { replaySafe: true, maxAttempts: 2 });
    await expect(port.get(allocation)).rejects.toMatchObject({ code: "state_scope_denied" });
    await expect(port.commit(stateCommit)).rejects.toMatchObject({ code: "state_scope_denied" });
    const next = await statePort(env, runId, await attemptAuthority(env, runId, replacement));
    expect(await next.commit(stateCommit)).toEqual(receipt);
    expect((await next.get(allocation))?.version).toBe(1);
    expect(count(db, "control_state_entries")).toBe(1);
    expect(count(db, "control_state_outbox")).toBe(1);
  });
  it("atomically rejects resource admission when an attempt expires after the preflight read", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env),
      claim = await activeClaim(env, runId);
    budget(db);
    const authority = await attemptAuthority(env, runId, claim),
      events = count(db, "control_plane_events");
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce((statements) => {
      expire(db, claim.stepId);
      return batch(statements);
    });
    await expect(usage(env, runId, authority)).rejects.toMatchObject({
      code: "durable_attempt_fenced",
    });
    expect(count(db, "control_resource_reservations")).toBe(0);
    expect(count(db, "control_plane_events")).toBe(events);
  });
  it("records incurred usage after expiry and reuses one logical operation only under the new attempt", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env),
      claim = await activeClaim(env, runId, { replaySafe: true, maxAttempts: 2 });
    budget(db);
    const authority = await attemptAuthority(env, runId, claim),
      first = await usage(env, runId, authority);
    expect(first.fresh).toBe(true);
    expire(db, claim.stepId);
    await settleRuntimeUsage(env, first.reservation, {
      status: "settled",
      inputTokens: 10,
      outputTokens: 5,
      source: "provider",
      result: { capacity: 7 },
    });
    await expect(usage(env, runId, authority)).rejects.toMatchObject({
      code: "durable_attempt_fenced",
    });
    const replacement = await activeClaim(env, runId, { replaySafe: true, maxAttempts: 2 });
    const replay = await usage(env, runId, await attemptAuthority(env, runId, replacement));
    expect(replay.fresh).toBe(false);
    expect(replay.reservation.id).toBe(first.reservation.id);
    expect(replay.reservation.status).toBe("settled");
    const secondStep = await activeClaim(env, runId, { key: "decide" });
    const independent = await usage(env, runId, await attemptAuthority(env, runId, secondStep));
    expect(independent.fresh).toBe(true);
    expect(independent.reservation.id).not.toBe(first.reservation.id);
    expect(count(db, "control_resource_reservations")).toBe(2);
  });
  it("replays structured output after safe step retry without another provider reservation", async () => {
    const { env, db } = fixture(),
      runId = await setupRun(env),
      claim = await activeClaim(env, runId, { replaySafe: true, maxAttempts: 2 });
    budget(db);
    env.OPERLOOM_E2E_MODE = "true";
    env.OPERLOOM_ENVIRONMENT = "local";
    const model = (durableAttempt: DurableAttemptAuthority) =>
      createRuntimeModelPort(env, identity, {
        runId,
        durableAttempt,
        signal: new AbortController().signal,
      });
    const request = {
      idempotencyKey: "summary",
      prompt: "Observe capacity",
      outputSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
    };
    const port = model(await attemptAuthority(env, runId, claim)),
      result = await port.structured(request);
    expire(db, claim.stepId);
    await expect(port.structured(request)).rejects.toMatchObject({
      code: "durable_attempt_fenced",
    });
    const replacement = await activeClaim(env, runId, { replaySafe: true, maxAttempts: 2 });
    expect(
      await model(await attemptAuthority(env, runId, replacement)).structured(request),
    ).toEqual(result);
    expect(count(db, "control_resource_reservations")).toBe(1);
  });
});

describe("durable context captures", () => {
  it("retains a step's evidence across attempt retries and refreshes only for a new logical step", async () => {
    const { env, db } = fixture();
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const resolver = vi.spyOn(controlPlane.context![0]!, "resolve").mockImplementation(() => ({
      status: "available",
      data: { text: "Scoped evidence" },
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 100).toISOString(),
      provenance: [{ reference: "fixture" }],
    }));
    const runId = await setupRun(env);
    const first = await activeClaim(env, runId, { replaySafe: true, maxAttempts: 2 });
    const capture = async (claim: { stepId: string; attemptId: string }) =>
      captureRuntimeContext(env, identity, {
        runId,
        runKind: "workflow",
        target: "simulation",
        input: {},
        signal: new AbortController().signal,
        durableAttempt: await attemptAuthority(env, runId, claim),
      });
    const evidence = (await capture(first))!;
    expect(evidence.snapshot).toMatchObject({
      revision: 0,
      captureKey: `step:${first.stepId}`,
      stepId: first.stepId,
    });
    evidence.assertReady();
    expire(db, first.stepId);
    vi.setSystemTime(now + 1000);
    const retry = await activeClaim(env, runId, { replaySafe: true, maxAttempts: 2 });
    const retained = (await capture(retry))!;
    expect(retained.snapshot).toEqual(evidence.snapshot);
    expect(() => retained.assertReady()).toThrow(
      expect.objectContaining({ code: "context_blocked" }),
    );
    const later = await activeClaim(env, runId, { key: "after-wait" });
    const refreshed = (await capture(later))!;
    refreshed.assertReady();
    expect(refreshed.snapshot).toMatchObject({ revision: 1, stepId: later.stepId });
    expect(refreshed.snapshot.id).not.toBe(evidence.snapshot.id);
    expect(refreshed.snapshot.contentHash).toBe(evidence.snapshot.contentHash);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(count(db, "control_context_snapshots")).toBe(2);
  });

  it("assigns distinct ordered revisions atomically, paginates metadata and isolates the listing", async () => {
    const { env, db } = fixture();
    const runId = await setupRun(env);
    const claims = await Promise.all([
      activeClaim(env, runId),
      activeClaim(env, runId, { key: "second" }),
    ]);
    const captures = await Promise.all(
      claims.map(async (claim) =>
        captureRuntimeContext(env, identity, {
          runId,
          runKind: "workflow",
          target: "simulation",
          input: { text: "Evidence" },
          signal: new AbortController().signal,
          durableAttempt: await attemptAuthority(env, runId, claim),
        }),
      ),
    );
    expect(captures.map((capture) => capture!.snapshot.revision).sort()).toEqual([0, 1]);
    const client = createRuntimeClient({
      baseUrl: "https://api",
      target: { workspaceId: "w", agentId: "a" },
      getAccessToken: async () => "test",
      fetch: ((url, init) =>
        handleListContextSnapshots(new Request(url, init), env, identity)) as typeof fetch,
    });
    const page = await client.context.list({ runId, runKind: "workflow", limit: 1 });
    expect(page.snapshots).toHaveLength(1);
    expect(page.snapshots[0]!.revision).toBe(0);
    expect(page.snapshots[0]).not.toHaveProperty("sources");
    expect(page.nextAfterRevision).toBe(0);
    const next = await client.context.list({
      runId,
      runKind: "workflow",
      afterRevision: page.nextAfterRevision,
      limit: 1,
    });
    expect(next.snapshots[0]!.revision).toBe(1);
    expect(next.nextAfterRevision).toBeUndefined();
    const pointer = JSON.parse(
      String(db.prepare("SELECT data_json FROM control_runs WHERE id=?").get(runId)!.data_json),
    );
    expect(pointer.contextSnapshotId).toBe(next.snapshots[0]!.id);
    const foreign = await handleListContextSnapshots(
      new Request(`https://api?runId=${runId}&runKind=workflow`),
      env,
      { ...identity, agentId: "other" },
    );
    expect((await foreign.json()).snapshots).toEqual([]);
    expect(
      (
        await handleListContextSnapshots(
          new Request(`https://api?runId=${runId}&runKind=workflow&limit=500`),
          env,
          identity,
        )
      ).status,
    ).toBe(400);
  });

  it("rolls back a new capture and latest pointer on a late failure while preserving prior evidence", async () => {
    const { env, db } = fixture();
    const runId = await setupRun(env);
    const capture = async (key: string) => {
      const claim = await activeClaim(env, runId, { key });
      return captureRuntimeContext(env, identity, {
        runId,
        runKind: "workflow",
        target: "simulation",
        input: { text: "Evidence" },
        signal: new AbortController().signal,
        durableAttempt: await attemptAuthority(env, runId, claim),
      });
    };
    const first = (await capture("first"))!;
    db.exec(
      "CREATE TRIGGER fail_context BEFORE INSERT ON control_plane_events WHEN NEW.type='context.captured' BEGIN SELECT RAISE(ABORT,'late'); END",
    );
    await expect(capture("second")).rejects.toMatchObject({ code: "context_persist_failed" });
    expect(count(db, "control_context_snapshots")).toBe(1);
    expect(
      JSON.parse(String(db.prepare("SELECT data_json FROM control_runs").get()!.data_json))
        .contextSnapshotId,
    ).toBe(first.snapshot.id);
  });

  it.each([
    { changed: false, requireApproval: false },
    { changed: true, requireApproval: false },
    { changed: false, requireApproval: true },
    { changed: true, requireApproval: true },
  ])(
    "executes the document workflow against post-wait evidence (%j)",
    async ({ changed, requireApproval }) => {
      const { env, db } = fixture();
      let waited = false;
      const original = controlPlane.context![0]!.resolve;
      vi.spyOn(controlPlane.context![0]!, "resolve").mockImplementation((input) =>
        original({
          ...input,
          input: changed && waited ? { text: "Changed document" } : input.input,
        }),
      );
      const runtime = resolvePackRuntime("document-review", "1.0.0");
      if (!runtime.runnable) throw new Error("Expected document package");
      const workflow = runtime.controlPlane.workflows.find(
        (item) => item.type === "document-review.review",
      )!;
      const { execution } = await admitDurableExecution(env, identity, {
        ...submission,
        definitionHash: await durableWorkflowDefinitionHash(runtime, workflow),
        workflowVersion: workflow.durable!.version,
        input: { documentId: "guide", text: "Original document", requireApproval },
      });
      const run = runDurableWorkflow(env, execution.run_id, {
        do: async (_name, _options, callback) => callback(),
        sleepUntil: async () => {
          waited = true;
        },
        waitForEvent: async (_name, options) => {
          const decision = await decideDurableApproval(env, identity, options.type, "approved");
          expect(decision.status).toBe(200);
        },
      });
      if (changed) await expect(run).rejects.toMatchObject({ code: "context_changed" });
      else await expect(run).resolves.toEqual({ runId: execution.run_id });
      const snapshots = db
        .prepare("SELECT id,revision,step_id FROM control_context_snapshots ORDER BY revision")
        .all();
      expect(snapshots.map((snapshot) => snapshot.revision)).toEqual([0, 1, 2]);
      expect(count(db, "control_state_records")).toBe(changed ? 0 : 1);
      if (!changed) {
        const decision = JSON.parse(
          String(db.prepare("SELECT data_json FROM control_state_entries").get()!.data_json),
        );
        expect(decision).toMatchObject({
          observationSnapshotId: snapshots[0]!.id,
          snapshotId: snapshots[2]!.id,
        });
      }
    },
  );
});
