import { afterEach, describe, expect, it, vi } from "vitest";
import { withRuntimeDeadline } from "./runtime-deadline";

describe("workflow execution deadline", () => {
  afterEach(() => vi.useRealTimers());
  it("terminates even when an adapter ignores cancellation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = withRuntimeDeadline(controller, 30_000, () => new Promise(() => {}));
    const result = expect(pending).rejects.toMatchObject({ code: "runtime_timeout" });
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(controller.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears the timer after success and does not abort completed work", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    await expect(withRuntimeDeadline(controller, 30_000, async () => "report")).resolves.toBe(
      "report",
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.signal.aborted).toBe(false);
  });
});
