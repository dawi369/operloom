import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getAdminSummarySnapshot,
  refreshAdminSummary,
  resetAdminSummaryResourceForTests,
  scheduleAdminSummaryRefresh,
  setAdminSummaryProjectionPreference,
  subscribeAdminSummary,
} from "./admin-summary-resource";

const summaryBody = {
  summary: {
    generatedAt: "2026-06-18T12:00:00.000Z",
  },
};

const jsonResponse = (body = summaryBody) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("admin summary resource", () => {
  beforeEach(() => {
    resetAdminSummaryResourceForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetAdminSummaryResourceForTests();
  });

  it("dedupes concurrent non-forced refreshes", async () => {
    let resolveResponse: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = refreshAdminSummary({ source: "initial" });
    const second = refreshAdminSummary({ source: "event" });
    resolveResponse(jsonResponse());

    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/workbench/admin-summary?projection=compact", {
      cache: "no-store",
    });
    expect(firstSnapshot.summary?.generatedAt).toBe(summaryBody.summary.generatedAt);
    expect(secondSnapshot.summary?.generatedAt).toBe(summaryBody.summary.generatedAt);
  });

  it("uses cooldown for automated refreshes and bypasses it for forced refreshes", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await refreshAdminSummary({ source: "initial" });
    await refreshAdminSummary({ source: "event" });
    await refreshAdminSummary({ source: "manual", force: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/workbench/admin-summary?projection=compact", {
      cache: "no-store",
    });
  });

  it("uses drawer projection while the Admin drawer preference is active", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    setAdminSummaryProjectionPreference("drawer");
    await refreshAdminSummary({ source: "drawer-open", force: true });

    expect(fetchMock).toHaveBeenCalledWith("/api/workbench/admin-summary?projection=drawer", {
      cache: "no-store",
    });
  });

  it("coalesces same-tick scheduled refreshes", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });

    void scheduleAdminSummaryRefresh({ source: "event" });
    void scheduleAdminSummaryRefresh({ source: "fallback-poll" });
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("schedules one trailing refresh when a request lands inside the cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T12:00:00.000Z"));
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });

    await refreshAdminSummary({ source: "initial" });
    void scheduleAdminSummaryRefresh({ source: "event" });
    void scheduleAdminSummaryRefresh({ source: "fallback-poll" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(899);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds catch-up refreshes and stops once the requested event is represented", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T12:00:00.000Z"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse())
      .mockResolvedValueOnce(
        jsonResponse({ summary: { generatedAt: "2026-06-18T12:00:02.000Z" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });

    const first = await refreshAdminSummary({
      source: "event",
      minimumGeneratedAt: "2026-06-18T12:00:01.000Z",
    });
    expect(first.syncStatus).toBe("catching_up");
    await vi.advanceTimersByTimeAsync(900);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getAdminSummarySnapshot().syncStatus).toBe("idle");
  });

  it("caps stale catch-up at three trailing requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T12:00:00.000Z"));
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });

    await refreshAdminSummary({
      source: "event",
      minimumGeneratedAt: "2026-06-18T12:00:05.000Z",
    });
    await vi.advanceTimersByTimeAsync(2_700);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(getAdminSummarySnapshot().syncStatus).toBe("exhausted");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends catch-up when a summary request fails so manual recovery remains available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("summary unavailable"))),
    );

    const result = await refreshAdminSummary({
      source: "event",
      minimumGeneratedAt: "2026-06-18T12:00:05.000Z",
    });

    expect(result.syncStatus).toBe("exhausted");
    expect(result.error).toBe("summary unavailable");
  });

  it("starts a fresh bounded catch-up budget when a newer event arrives", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T12:00:00.000Z"));
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });

    await refreshAdminSummary({
      source: "event",
      minimumGeneratedAt: "2026-06-18T12:00:05.000Z",
    });
    await vi.advanceTimersByTimeAsync(1_800);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    void scheduleAdminSummaryRefresh({
      source: "event",
      minimumGeneratedAt: "2026-06-18T12:00:06.000Z",
    });
    void scheduleAdminSummaryRefresh({
      source: "fallback-poll",
      minimumGeneratedAt: "2026-06-18T12:00:06.000Z",
    });
    await vi.advanceTimersByTimeAsync(1_800);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(getAdminSummarySnapshot().syncStatus).toBe("catching_up");
  });

  it("keeps the newest projection and strongest source in a cooldown burst", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T12:00:00.000Z"));
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });

    await refreshAdminSummary({ source: "initial" });
    void scheduleAdminSummaryRefresh({ source: "fallback-poll", projection: "compact" });
    void scheduleAdminSummaryRefresh({ source: "drawer-open", projection: "drawer" });
    await vi.advanceTimersByTimeAsync(900);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/workbench/admin-summary?projection=drawer", {
      cache: "no-store",
    });
    expect(getAdminSummarySnapshot().lastRefreshSource).toBe("drawer-open");
  });

  it("cleans a pending catch-up timer when the last subscriber unmounts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T12:00:00.000Z"));
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    const unsubscribe = subscribeAdminSummary(() => undefined);

    await refreshAdminSummary({
      source: "event",
      minimumGeneratedAt: "2026-06-18T12:00:05.000Z",
    });
    expect(vi.getTimerCount()).toBe(1);
    unsubscribe();

    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
