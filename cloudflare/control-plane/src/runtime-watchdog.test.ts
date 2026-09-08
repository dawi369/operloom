import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./runtime-run-lifecycle", () => ({
  finishPackWorkflowRun: vi.fn(async () => ({ applied: true })),
}));
import { finishPackWorkflowRun } from "./runtime-run-lifecycle";
import {
  recoverRuntimeDeadlines,
  storeRuntimeDeadline,
  type RuntimeDeadline,
} from "./runtime-watchdog";
import type { DurableObjectStorage, Env } from "./types";

const input = {
  identity: { scope: { userId: "user", workspaceId: "workspace" }, agentId: "agent" },
  run: { runId: "run", workflowIntentId: "intent", relation: {} },
  workflowType: "repo.readiness_report",
  deadline: 45_000,
} as RuntimeDeadline;

describe("durable manual workflow recovery", () => {
  beforeEach(() => vi.clearAllMocks());
  it("survives a worker restart and recovers without schedules", async () => {
    const data = new Map<string, unknown>();
    const storage: DurableObjectStorage = {
      get: async <T>(key: string) => data.get(key) as T | undefined,
      put: async (key, value) => {
        data.set(key, value);
      },
      setAlarm: vi.fn(async () => {}),
    };
    await storeRuntimeDeadline(storage, input);
    expect(storage.setAlarm).toHaveBeenCalledWith(45_000);
    await recoverRuntimeDeadlines(storage, {} as Env, 44_999);
    expect(finishPackWorkflowRun).not.toHaveBeenCalled();
    // Recovery reads persisted storage, not an in-memory timer or schedule.
    await recoverRuntimeDeadlines(storage, {} as Env, 45_000);
    expect(finishPackWorkflowRun).toHaveBeenCalledWith(
      {},
      input.identity,
      expect.objectContaining({ runId: "run", ok: false }),
    );
    await recoverRuntimeDeadlines(storage, {} as Env, 60_000);
    expect(finishPackWorkflowRun).toHaveBeenCalledTimes(1);
  });
  it("retains failed cleanup for alarm retry", async () => {
    const storage: DurableObjectStorage = {
      get: async <T>() => [input] as T,
      put: vi.fn(),
      setAlarm: vi.fn(),
    };
    vi.mocked(finishPackWorkflowRun).mockRejectedValueOnce(new Error("D1 unavailable"));
    await expect(recoverRuntimeDeadlines(storage, {} as Env, 45_000)).rejects.toThrow(
      "D1 unavailable",
    );
    expect(storage.put).not.toHaveBeenCalled();
  });
});
