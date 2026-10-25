import { describe, expect, it } from "vitest";

import { brier, calibration, evaluateWatch, scoreSummary, wilson } from "./record";

const now = Date.parse("2026-10-01T12:00:00Z");
const hour = 3_600_000;
const base = {
  now,
  deadline: "2026-12-31T00:00:00Z",
  watch: {},
  failed: false,
  rulesChanged: false,
  signposts: [],
  alertPoints: 10,
};

describe("scores", () => {
  it("computes Brier, hit rate and Wilson bands", () => {
    expect(brier(0.4, 1)).toBe(0.36);
    expect(brier(0.5, 0)).toBe(0.25);
    expect(
      scoreSummary([
        { probability: 0.8, outcome: 1 },
        { probability: 0.3, outcome: 1 },
      ]),
    ).toEqual({ count: 2, meanBrier: 0.265, hitRate: 0.5 });
    expect(scoreSummary([])).toEqual({ count: 0, meanBrier: null, hitRate: null });
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
    const band = wilson(7, 10);
    expect(band.low).toBeLessThan(0.7);
    expect(band.high).toBeGreaterThan(0.7);
  });

  it("buckets forecasts by ten points with observed frequencies", () => {
    expect(
      calibration([
        { probability: 0.62, outcome: 1 },
        { probability: 0.68, outcome: 0 },
        { probability: 1, outcome: 1 },
      ]),
    ).toMatchObject([
      { bucket: "60–70%", count: 2, meanForecast: 0.65, observed: 0.5 },
      { bucket: "90–100%", count: 1, observed: 1 },
    ]);
  });
});

describe("watch evaluation", () => {
  it("takes a baseline first, then alerts on a move past the threshold", () => {
    const first = evaluateWatch({ ...base, quote: { status: "open", price: 0.45 } });
    expect(first).toMatchObject({ alerts: [], research: false, next: { baselinePrice: 0.45 } });
    const quiet = evaluateWatch({
      ...base,
      watch: first.next,
      quote: { status: "open", price: 0.5 },
    });
    expect(quiet.alerts).toEqual([]);
    const moved = evaluateWatch({
      ...base,
      watch: first.next,
      quote: { status: "open", price: 0.6 },
    });
    expect(moved).toMatchObject({
      alerts: [{ kind: "price_move", text: "The market moved from 45% to 60%." }],
      research: true,
      next: { baselinePrice: 0.6, lastAlertAt: new Date(now).toISOString() },
    });
  });

  it("alerts at most once a day except for a settlement", () => {
    const watch = { baselinePrice: 0.45, lastAlertAt: new Date(now - 2 * hour).toISOString() };
    expect(evaluateWatch({ ...base, watch, quote: { status: "open", price: 0.7 } }).alerts).toEqual(
      [],
    );
    expect(
      evaluateWatch({ ...base, watch, quote: { status: "settled", payout: 1 } }),
    ).toMatchObject({ settled: true, alerts: [{ kind: "resolved" }] });
  });

  it("fires date signposts and the deadline warning once", () => {
    const result = evaluateWatch({
      ...base,
      deadline: new Date(now + 3 * 24 * hour).toISOString(),
      signposts: [{ id: "sp1", text: "FOMC meeting", kind: "date", date: "2026-09-30" }],
    });
    expect(result.alerts.map((alert) => alert.kind)).toEqual(["signpost", "deadline_near"]);
    expect(result.next).toMatchObject({ firedSignposts: ["sp1"], deadlineAlerted: true });
    expect(
      evaluateWatch({
        ...base,
        now: now + 25 * hour,
        watch: result.next,
        signposts: [{ id: "sp1", text: "FOMC meeting", kind: "date", date: "2026-09-30" }],
      }).alerts,
    ).toEqual([]);
  });

  it("marks a watch stale after three failed reads and recovers on the next quote", () => {
    let watch = {};
    for (let attempt = 0; attempt < 3; attempt += 1)
      watch = evaluateWatch({ ...base, watch, failed: true }).next;
    expect(watch).toMatchObject({ failures: 3, staleSince: new Date(now).toISOString() });
    const recovered = evaluateWatch({ ...base, watch, quote: { status: "open", price: 0.5 } });
    expect(recovered.next).toMatchObject({ failures: 0 });
    expect(recovered.next).not.toHaveProperty("staleSince");
  });
});
