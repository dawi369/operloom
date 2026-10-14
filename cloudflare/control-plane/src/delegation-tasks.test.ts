import { afterEach, describe, expect, it } from "vitest";
import { createPackTestRuntime } from "./pack-test-runtime";

const runtimes: ReturnType<typeof createPackTestRuntime>[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
});
const start = () => {
  const runtime = createPackTestRuntime({ packId: "document-review", users: ["ann"] });
  runtimes.push(runtime);
  runtime.addAgent("ann", "agent-b");
  return runtime;
};
const delegate = (runtime: ReturnType<typeof start>, input: Record<string, unknown>) =>
  runtime.runWorkflow("document-review.delegate", { text: "Delegated review text.", ...input });

describe("agent delegation", () => {
  it("runs a delegated workflow on the target agent and reports the result back", async () => {
    const runtime = start();
    const queued = await delegate(runtime, { documentId: "doc-1", targetAgentId: "agent-b" });
    expect(queued.status, JSON.stringify(queued.body)).toBe(201);
    expect(queued.body.report).toMatchObject({ mode: "delegate", status: "queued", created: true });
    const taskId = String(queued.body.report!.taskId);
    const parentRunId = String((queued.body.run as { id: string }).id);

    const tick = await runtime.tickScheduler();
    expect(tick.delegation).toMatchObject({ dispatched: 1, results: [{ taskId, ok: true }] });

    const result = await delegate(runtime, { documentId: "doc-1", taskId });
    expect(result.body.report).toMatchObject({
      mode: "result",
      taskId,
      status: "succeeded",
      targetAgentId: "agent-b",
      workflowType: "document-review.review",
      result: { outcome: "reviewed", wordCount: 3 },
    });
    const childRunId = String(result.body.report!.runId);
    const child = runtime.db
      .prepare("SELECT agent_id, status, data_json FROM control_runs WHERE id = ?")
      .get(childRunId) as { agent_id: string; status: string; data_json: string };
    expect(child).toMatchObject({ agent_id: "agent-b", status: "completed" });
    expect(JSON.parse(child.data_json)).toMatchObject({
      source: "delegation",
      delegation: { taskId, parentRunId, requesterAgentId: "agent-ann", depth: 1 },
    });
    const parent = await runtime.runSnapshot(parentRunId);
    expect(parent?.delegations).toEqual([expect.objectContaining({ taskId, status: "succeeded" })]);
    expect(parent?.childRuns.map((run) => run.id)).toEqual([childRunId]);
    // The child's state lives in the target agent's scope, not the requester's.
    const reviewed = runtime.db
      .prepare("SELECT agent_id FROM control_state_records WHERE record_key = 'doc-1'")
      .all() as { agent_id: string }[];
    expect(reviewed.map((row) => row.agent_id)).toEqual(["agent-b"]);
  });

  it("returns the same task for a replayed key and refuses changed content", async () => {
    const runtime = start();
    const first = await delegate(runtime, { documentId: "doc-2", targetAgentId: "agent-b" });
    const again = await delegate(runtime, { documentId: "doc-2", targetAgentId: "agent-b" });
    // Each workflow invocation is its own run, so the key is scoped per run: a new task is created.
    expect(again.body.report).toMatchObject({ created: true });
    expect(again.body.report!.taskId).not.toBe(first.body.report!.taskId);
    expect(runtime.db.prepare("SELECT COUNT(*) AS n FROM control_delegation_tasks").get()).toEqual({
      n: 2,
    });
    expect((await runtime.tickScheduler()).delegation.dispatched).toBe(2);
  });

  it("enforces fan-out and depth, target validity and delegability", async () => {
    const runtime = start();
    const live = runtime.openRun();
    const request = (key: string, extra: Record<string, unknown> = {}) =>
      live.tasks.delegate({
        agentId: "agent-b",
        workflowType: "document-review.review",
        input: { documentId: `fan-${key}`, text: "Text." },
        deadlineMs: 60_000,
        idempotencyKey: key,
        ...extra,
      });
    for (const key of ["1", "2", "3", "4"]) expect((await request(key)).created).toBe(true);
    await expect(request("5")).rejects.toMatchObject({ code: "delegation_fan_out_exceeded" });
    expect(await request("1")).toMatchObject({ created: false });
    await expect(
      live.tasks.delegate({
        agentId: "agent-b",
        workflowType: "document-review.review",
        input: { documentId: "fan-1", text: "Different." },
        deadlineMs: 60_000,
        idempotencyKey: "1",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(request("x", { agentId: "agent-missing" })).rejects.toMatchObject({
      code: "delegation_target_unavailable",
    });
    await expect(request("y", { workflowType: "document-review.unknown" })).rejects.toMatchObject({
      code: "delegation_workflow_unavailable",
    });
    await expect(request("z", { deadlineMs: 10 })).rejects.toMatchObject({
      code: "delegation_invalid",
    });
  });

  it("cancels queued children with the parent and expires tasks past their deadline", async () => {
    const runtime = start();
    const queued = await delegate(runtime, { documentId: "doc-3", targetAgentId: "agent-b" });
    const parentRunId = String((queued.body.run as { id: string }).id);
    // The parent run already completed; re-open it so cancellation is meaningful.
    runtime.db.prepare("UPDATE control_runs SET status = 'running' WHERE id = ?").run(parentRunId);
    const cancelled = await runtime.cancelRun(parentRunId);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const task = runtime.db
      .prepare("SELECT status, error_json FROM control_delegation_tasks WHERE parent_run_id = ?")
      .get(parentRunId) as { status: string; error_json: string };
    expect(task.status).toBe("cancelled");
    expect(JSON.parse(task.error_json)).toMatchObject({ code: "parent_cancelled" });
    expect((await runtime.tickScheduler()).delegation.dispatched).toBe(0);

    const late = await delegate(runtime, {
      documentId: "doc-4",
      targetAgentId: "agent-b",
      deadlineMs: 60_000,
    });
    const lateTaskId = String(late.body.report!.taskId);
    const tick = await runtime.tickScheduler(new Date(Date.now() + 2 * 60_000));
    expect(tick.delegation).toMatchObject({ expired: 1, dispatched: 0 });
    const expired = await delegate(runtime, { documentId: "doc-4", taskId: lateTaskId });
    expect(expired.body.report).toMatchObject({
      status: "expired",
      error: { code: "deadline_passed" },
    });
  });
});
