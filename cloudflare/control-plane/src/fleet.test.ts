import { describe, expect, it } from "vitest";

import { fleetSnapshot, handleFleet } from "./fleet";
import { createPackTestRuntime } from "./pack-test-runtime";

const now = new Date("2026-05-01T12:00:00.000Z");
const run = { agentRevision: 0, effectTarget: "simulation" };

const seed = (
  db: ReturnType<typeof createPackTestRuntime>["db"],
  identity: ReturnType<ReturnType<typeof createPackTestRuntime>["identity"]>,
) => {
  const { userId, workspaceId } = identity.scope;
  const agentId = identity.agentId;
  db.prepare(
    `INSERT INTO control_workflow_intents (id,user_id,workspace_id,agent_id,stage,type,execution_json,payload_json,status,created_at,updated_at)
     VALUES (?,?,?,?,'execute','inspect.site','{}','{}','running',?,?)`,
  ).run(`intent-${agentId}`, userId, workspaceId, agentId, now.toISOString(), now.toISOString());
  const insertRun = (id: string, status: string, createdAt: string, summary?: string) =>
    db
      .prepare(
        `INSERT INTO control_runs (id,user_id,workspace_id,agent_id,workflow_intent_id,status,execution_json,data_json,created_at,updated_at,completed_at,failed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        userId,
        workspaceId,
        agentId,
        `intent-${agentId}`,
        status,
        JSON.stringify(run),
        JSON.stringify(summary ? { summary } : {}),
        createdAt,
        createdAt,
        status === "completed" ? createdAt : null,
        status === "failed" ? createdAt : null,
      );
  return insertRun;
};

describe("fleet snapshot", () => {
  it("is idle with no history and reports zero counts", async () => {
    const runtime = createPackTestRuntime({ packId: "complex-operator" });
    const [agent] = await fleetSnapshot(runtime.env, runtime.identity(), now);
    expect(agent).toMatchObject({
      status: "idle",
      currentRun: null,
      lastRun: null,
      openApprovals: 0,
      runsToday: 0,
      tokensToday: 0,
      triggers: { enabled: 0, paused: 0, nextTickAt: null },
      lastError: null,
    });
  });

  it("derives status in priority order and keeps today's counts per agent", async () => {
    const runtime = createPackTestRuntime({ packId: "complex-operator" });
    const identity = runtime.identity();
    const insertRun = seed(runtime.db, identity);
    insertRun("r-old", "completed", "2026-04-30T09:00:00.000Z", "Yesterday");
    insertRun("r-failed", "failed", "2026-05-01T08:00:00.000Z", "Boom");
    let [agent] = await fleetSnapshot(runtime.env, identity, now);
    expect(agent!.status).toBe("erroring");
    expect(agent!.lastError).toMatchObject({ runId: "r-failed", summary: "Boom" });
    expect(agent!.runsToday).toBe(1);
    expect(agent!.failedToday).toBe(1);

    insertRun("r-ok", "completed", "2026-05-01T09:00:00.000Z", "Fixed");
    [agent] = await fleetSnapshot(runtime.env, identity, now);
    expect(agent!.status).toBe("idle");
    expect(agent!.lastRun).toMatchObject({
      id: "r-ok",
      summary: "Fixed",
      workflowType: "inspect.site",
    });
    expect(agent!.lastError?.runId).toBe("r-failed");

    insertRun("r-live", "running", "2026-05-01T11:00:00.000Z");
    [agent] = await fleetSnapshot(runtime.env, identity, now);
    expect(agent!.status).toBe("running");
    expect(agent!.currentRun).toMatchObject({ id: "r-live", workflowType: "inspect.site" });

    runtime.db
      .prepare(
        `INSERT INTO control_approval_requests (id,user_id,workspace_id,agent_id,workflow_intent_id,run_id,tool_id,status,reason,data_json,created_at,updated_at)
         VALUES ('ap',?,?,?,?,'r-live','tool','requested','policy','{}',?,?)`,
      )
      .run(
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        `intent-${identity.agentId}`,
        now.toISOString(),
        now.toISOString(),
      );
    [agent] = await fleetSnapshot(runtime.env, identity, now);
    expect(agent!.status).toBe("waiting_approval");
    expect(agent!.openApprovals).toBe(1);

    runtime.db.prepare("UPDATE agents SET status = 'archived' WHERE id = ?").run(identity.agentId);
    [agent] = await fleetSnapshot(runtime.env, identity, now);
    expect(agent!.status).toBe("paused");
  });

  it("reports the earliest enabled tick and ignores other workspaces", async () => {
    const runtime = createPackTestRuntime({ packId: "complex-operator", users: ["alice", "bob"] });
    const identity = runtime.identity();
    const { workspaceId } = identity.scope;
    const trigger = (
      id: string,
      agentId: string,
      workspaceId: string,
      status: string,
      next: string | null,
    ) =>
      runtime.db
        .prepare(
          `INSERT INTO control_triggers (id,user_id,workspace_id,agent_id,pack_id,pack_trigger_id,kind,workflow_type,status,execution_json,config_json,max_concurrent_runs,next_trigger_at,created_by_user_id,created_at,updated_at)
           VALUES (?, 'alice',?,?,'complex-operator',?,'monitor','inspect.site',?,'{}','{}',1,?,'alice','now','now')`,
        )
        .run(id, workspaceId, agentId, id, status, next);
    trigger("t-late", identity.agentId, workspaceId, "enabled", "2026-05-01T13:00:00.000Z");
    trigger("t-soon", identity.agentId, workspaceId, "enabled", "2026-05-01T12:05:00.000Z");
    trigger("t-paused", identity.agentId, workspaceId, "paused", "2026-05-01T12:01:00.000Z");
    trigger("t-bob", "agent-bob", "ws-bob", "enabled", "2026-05-01T12:00:30.000Z");
    const agents = await fleetSnapshot(runtime.env, identity, now);
    expect(agents.map((agent) => agent.id)).toEqual([identity.agentId]);
    expect(agents[0]!.triggers).toEqual({
      enabled: 2,
      paused: 1,
      nextTickAt: "2026-05-01T12:05:00.000Z",
      lastTickAt: null,
    });
  });

  it("answers the route with the contract shape", async () => {
    const runtime = createPackTestRuntime({ packId: "complex-operator" });
    const body = (await (await handleFleet(runtime.env, runtime.identity())).json()) as {
      ok: boolean;
      generatedAt: string;
      agents: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(typeof body.generatedAt).toBe("string");
    expect(body.agents).toHaveLength(1);
  });
});
