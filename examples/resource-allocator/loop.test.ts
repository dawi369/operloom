import { afterEach, describe, expect, it } from "vitest";

import { createPackTestRuntime } from "../../cloudflare/control-plane/src/pack-test-runtime";

const runtimes: ReturnType<typeof createPackTestRuntime>[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
});
const start = () => {
  const runtime = createPackTestRuntime({ packId: "resource-allocator", users: ["ann", "bob"] });
  runtimes.push(runtime);
  return runtime;
};
const cycle = (runtime: ReturnType<typeof start>, demand: number, user = "ann") =>
  runtime.runWorkflow("resource-allocator.cycle", { pool: "primary", demand }, { user });

describe("resource allocator loop", () => {
  it("no-ops below the threshold, escalates once and ignores a replayed observation", async () => {
    const runtime = start();
    expect((await cycle(runtime, 1)).body.report).toMatchObject({ outcome: "noop", allocated: 0 });
    const escalated = await cycle(runtime, 10);
    expect(escalated.status, JSON.stringify(escalated.body)).toBe(201);
    expect(escalated.body.report).toMatchObject({ outcome: "escalated" });
    expect((await cycle(runtime, 10)).body.report).toMatchObject({ outcome: "no_change" });

    const decisions = runtime.entries("decision");
    expect(decisions.map((entry) => entry.outcome)).toEqual(["noop", "escalate"]);
    expect(decisions[1]).toMatchObject({ units: 5, unmet: 10, settingsVersion: 0 });
    const request = await (
      await runtime.state()
    ).get({
      namespace: "capacity",
      kind: "request",
      key: String(escalated.body.report!.proposalId),
    });
    expect(request?.data).toMatchObject({ status: "proposed", units: 5, pool: "primary" });
  });

  it("applies pinned settings and keeps each user's agent isolated", async () => {
    const runtime = start();
    expect((await runtime.updateSettings({ escalateAbove: 20 })).status).toBe(200);
    expect((await cycle(runtime, 10)).body.report).toMatchObject({ outcome: "noop" });
    expect((await cycle(runtime, 10, "bob")).body.report).toMatchObject({ outcome: "escalated" });
    const overview = await runtime.runQuery("resource-allocator.overview", {}, "ann");
    expect(overview.body.output).toMatchObject({
      pools: [{ pool: "primary", capacity: 20, available: 20 }],
      requests: [],
    });
    expect(runtime.entries("decision", "bob").map((entry) => entry.outcome)).toEqual(["escalate"]);
  });
});
