import { describe, expect, it } from "vitest";

import {
  agentUpdatesPerRun,
  clampUpdateText,
  latestUpdatesByAgent,
  listAgentTimeline,
  postAgentUpdate,
} from "./agent-updates";
import { appendControlPlaneEvent } from "./control-plane-events";
import { fleetSnapshot } from "./fleet";
import { createPackTestRuntime } from "./pack-test-runtime";

describe("agent updates", () => {
  it("clamps to one trimmed line with an ellipsis", () => {
    expect(clampUpdateText("  two\n\n  lines   here ")).toBe("two lines here");
    const long = "x".repeat(300);
    expect(clampUpdateText(long)).toHaveLength(280);
    expect(clampUpdateText(long).endsWith("…")).toBe(true);
    expect(clampUpdateText("hello world", 8)).toBe("hello w…");
  });

  it("stores a line per post and stops at the per-run allowance", async () => {
    const runtime = createPackTestRuntime({ packId: "complex-operator" });
    const identity = runtime.identity();
    for (let index = 0; index < agentUpdatesPerRun; index += 1) {
      expect(
        await postAgentUpdate(runtime.env, identity, { runId: "r1", text: `step ${index}` }),
      ).toBe(true);
    }
    expect(
      await postAgentUpdate(runtime.env, identity, { runId: "r1", text: "one too many" }),
    ).toBe(false);
    expect(await postAgentUpdate(runtime.env, identity, { runId: "r2", text: "fresh run" })).toBe(
      true,
    );
    expect(await postAgentUpdate(runtime.env, identity, { runId: "r2", text: "   " })).toBe(false);
    const latest = await latestUpdatesByAgent(runtime.env, identity.scope.workspaceId, {
      perAgent: 2,
      chars: 140,
    });
    expect(latest.get(identity.agentId)?.map((update) => update.text)).toEqual([
      "fresh run",
      `step ${agentUpdatesPerRun - 1}`,
    ]);
    expect(latest.get(identity.agentId)?.[0]?.runId).toBe("r2");
  });

  it("lists a mixed timeline newest first with a stable cursor", async () => {
    const runtime = createPackTestRuntime({ packId: "complex-operator" });
    const identity = runtime.identity();
    await appendControlPlaneEvent(runtime.env, identity, {
      type: "run.started",
      summary: "Started",
      targetType: "run",
      targetId: "r1",
    });
    await postAgentUpdate(runtime.env, identity, { runId: "r1", text: "Checked 12 leads" });
    await appendControlPlaneEvent(runtime.env, identity, {
      type: "tool.policy.changed",
      summary: "not on the board",
    });
    await appendControlPlaneEvent(runtime.env, identity, {
      type: "run.completed",
      summary: "Done",
      targetType: "run",
      targetId: "r1",
    });
    const first = await listAgentTimeline(
      runtime.env,
      identity.scope.workspaceId,
      identity.agentId,
      {
        limit: 2,
        chars: 280,
      },
    );
    expect(first.updates.map((update) => update.type)).toEqual(["run.completed", "agent.update"]);
    expect(first.nextBefore).toBe(first.updates[1]!.id);
    const second = await listAgentTimeline(
      runtime.env,
      identity.scope.workspaceId,
      identity.agentId,
      {
        limit: 2,
        before: first.nextBefore!,
        chars: 280,
      },
    );
    expect(second.updates.map((update) => update.type)).toEqual(["run.started"]);
    expect(second.nextBefore).toBeNull();
  });

  it("surfaces the latest lines on the fleet board at the requested length", async () => {
    const runtime = createPackTestRuntime({ packId: "complex-operator" });
    const identity = runtime.identity();
    await postAgentUpdate(runtime.env, identity, { runId: "r1", text: "a".repeat(100) });
    await postAgentUpdate(runtime.env, identity, { runId: "r1", text: "latest" });
    const [agent] = await fleetSnapshot(runtime.env, identity, new Date(), {
      updatesPerAgent: 1,
      updateChars: 40,
    });
    expect(agent!.updates.map((update) => update.text)).toEqual(["latest"]);
    const [verbose] = await fleetSnapshot(runtime.env, identity, new Date(), {
      updatesPerAgent: 5,
      updateChars: 40,
    });
    expect(verbose!.updates).toHaveLength(2);
    expect(verbose!.updates[1]!.text).toHaveLength(40);
    const [none] = await fleetSnapshot(runtime.env, identity, new Date(), {
      updatesPerAgent: 0,
      updateChars: 40,
    });
    expect(none!.updates).toEqual([]);
  });
});
