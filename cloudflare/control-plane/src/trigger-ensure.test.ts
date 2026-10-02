import { afterEach, describe, expect, it } from "vitest";

import { createPackTestRuntime } from "./pack-test-runtime";
import { ensureDeclaredTrigger } from "./triggers";

const runtimes: ReturnType<typeof createPackTestRuntime>[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
});
const start = () => {
  const runtime = createPackTestRuntime({ packId: "resource-allocator" });
  runtimes.push(runtime);
  return runtime;
};
const ensure = (runtime: ReturnType<typeof start>, packTriggerId = "capacity-monitor") =>
  ensureDeclaredTrigger(runtime.env, runtime.identity(), "resource-allocator", packTriggerId);

describe("package trigger ensure", () => {
  it("installs a declared monitor enabled once and leaves an operator's pause in place", async () => {
    const runtime = start();
    const first = await ensure(runtime);
    expect(first).toMatchObject({ status: "enabled", created: true });
    expect(await ensure(runtime)).toEqual({ ...first, created: false });

    runtime.db.prepare("UPDATE control_triggers SET status = 'paused' WHERE id = ?").run(first.id);
    expect(await ensure(runtime)).toEqual({ id: first.id, status: "paused", created: false });
    const row = runtime.db
      .prepare("SELECT kind, status, next_trigger_at, execution_json FROM control_triggers")
      .get() as { kind: string; next_trigger_at: string | null; execution_json: string };
    expect(row).toMatchObject({ kind: "monitor", status: "paused" });
    expect(row.next_trigger_at).not.toBeNull();
    expect(JSON.parse(row.execution_json)).toEqual({
      mode: "dry_run",
      policy: "trigger-readonly-v0",
    });
  });

  it("refuses undeclared triggers and non-admin members", async () => {
    const runtime = start();
    await expect(ensure(runtime, "missing")).rejects.toMatchObject({
      code: "trigger_undeclared",
    });
    runtime.db.prepare("UPDATE memberships SET role = 'member'").run();
    await expect(ensure(runtime)).rejects.toMatchObject({ code: "admin_required" });
    expect(runtime.db.prepare("SELECT COUNT(*) AS count FROM control_triggers").get()).toEqual({
      count: 0,
    });
  });
});
