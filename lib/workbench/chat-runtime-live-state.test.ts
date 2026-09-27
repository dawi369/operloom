import { describe, expect, it } from "vitest";

import { describeSummarySync } from "./chat-runtime-live-state";

describe("runtime summary sync presentation", () => {
  it("does not claim to be synchronizing when stale and idle", () => {
    expect(describeSummarySync({ isStale: true, isLoading: false, syncStatus: "idle" })).toEqual({
      message: "Runtime details are out of date.",
      canRefresh: true,
    });
  });

  it("shows active catch-up and offers recovery after exhaustion", () => {
    expect(
      describeSummarySync({ isStale: true, isLoading: true, syncStatus: "idle" }),
    ).toMatchObject({ canRefresh: false, message: expect.stringContaining("Refreshing") });
    expect(
      describeSummarySync({ isStale: true, isLoading: false, syncStatus: "catching_up" }),
    ).toMatchObject({ canRefresh: false, message: expect.stringContaining("Refreshing") });
    expect(
      describeSummarySync({ isStale: true, isLoading: false, syncStatus: "exhausted" }),
    ).toMatchObject({ canRefresh: true, message: expect.stringContaining("delayed") });
  });

  it("clears the notice when fresh", () => {
    expect(
      describeSummarySync({ isStale: false, isLoading: false, syncStatus: "idle" }),
    ).toBeNull();
  });
});
