import { describe, expect, it } from "vitest";

import {
  assertOutreachAllowed,
  outreachDayRange,
  parseOutreachPolicy,
  withinOutreachWindow,
} from "./outreach-policy";
import { createPackTestRuntime } from "./pack-test-runtime";

describe("outreach policy", () => {
  it("parses only well-formed policies", () => {
    expect(parseOutreachPolicy(undefined)).toBeNull();
    expect(parseOutreachPolicy({})).toEqual({});
    expect(parseOutreachPolicy({ dailyCap: 25 })).toEqual({ dailyCap: 25 });
    expect(parseOutreachPolicy({ dailyCap: -1 })).toBeNull();
    expect(parseOutreachPolicy({ dailyCap: 1.5 })).toBeNull();
    expect(
      parseOutreachPolicy({ window: { start: "09:00", end: "20:00", timezone: "America/Denver" } }),
    ).toEqual({ window: { start: "09:00", end: "20:00", timezone: "America/Denver" } });
    expect(parseOutreachPolicy({ window: { start: "9:00", end: "20:00" } })).toBeNull();
    expect(
      parseOutreachPolicy({ window: { start: "09:00", end: "20:00", timezone: "Mars/Olympus" } }),
    ).toBeNull();
  });

  it("checks the window in the policy's timezone and wraps past midnight", () => {
    const denver = { window: { start: "09:00", end: "20:00", timezone: "America/Denver" } };
    // 14:00 UTC is 08:00 in Denver during daylight time.
    expect(withinOutreachWindow(denver, new Date("2026-07-01T14:00:00Z"))).toBe(false);
    expect(withinOutreachWindow(denver, new Date("2026-07-01T15:00:00Z"))).toBe(true);
    expect(withinOutreachWindow(denver, new Date("2026-07-02T01:59:00Z"))).toBe(true);
    expect(withinOutreachWindow(denver, new Date("2026-07-02T02:00:00Z"))).toBe(false);
    const night = { window: { start: "22:00", end: "06:00" } };
    expect(withinOutreachWindow(night, new Date("2026-07-01T23:00:00Z"))).toBe(true);
    expect(withinOutreachWindow(night, new Date("2026-07-01T05:59:00Z"))).toBe(true);
    expect(withinOutreachWindow(night, new Date("2026-07-01T12:00:00Z"))).toBe(false);
    expect(withinOutreachWindow({ dailyCap: 1 }, new Date())).toBe(true);
  });

  it("maps the cap to the local calendar day", () => {
    const tokyo = { window: { start: "09:00", end: "18:00", timezone: "Asia/Tokyo" } };
    // 23:00 UTC on 1 July is 08:00 on 2 July in Tokyo.
    expect(outreachDayRange(tokyo, new Date("2026-07-01T23:00:00Z"))).toEqual({
      start: "2026-07-01T15:00:00.000Z",
      end: "2026-07-02T15:00:00.000Z",
    });
    expect(outreachDayRange({}, new Date("2026-07-01T23:00:00Z"))).toEqual({
      start: "2026-07-01T00:00:00.000Z",
      end: "2026-07-02T00:00:00.000Z",
    });
  });

  it("applies the cap to the count the reader returns for the local day", async () => {
    const runtime = createPackTestRuntime({ packId: "complex-operator" });
    const identity = runtime.identity();
    const now = new Date("2026-07-01T23:30:00Z");
    const seen: { operationId: string; range: { start: string; end: string } }[] = [];
    const reader =
      (count: number): Parameters<typeof assertOutreachAllowed>[5] =>
      async (_env, _identity, operationId, range) => {
        seen.push({ operationId, range });
        return count;
      };
    const tokyo = { dailyCap: 2, window: { start: "00:00", end: "23:59", timezone: "Asia/Tokyo" } };
    await expect(
      assertOutreachAllowed(runtime.env, identity, "sms.send", tokyo, now, reader(1)),
    ).resolves.toBeUndefined();
    expect(seen[0]).toEqual({
      operationId: "sms.send",
      range: { start: "2026-07-01T15:00:00.000Z", end: "2026-07-02T15:00:00.000Z" },
    });
    await expect(
      assertOutreachAllowed(runtime.env, identity, "sms.send", tokyo, now, reader(2)),
    ).rejects.toThrow("outreach_daily_cap_reached");
    await expect(
      assertOutreachAllowed(
        runtime.env,
        identity,
        "sms.send",
        { window: { start: "13:00", end: "14:00" } },
        now,
        reader(0),
      ),
    ).rejects.toThrow("outreach_window_closed");
    await expect(
      assertOutreachAllowed(runtime.env, identity, "sms.send", {}, now, reader(999)),
    ).resolves.toBeUndefined();
    expect(seen).toHaveLength(2);
  });

  it("rejects a window with a non-IANA timezone instead of ignoring it", () => {
    expect(
      parseOutreachPolicy({ window: { start: "09:00", end: "17:00", timezone: "EST5" } }),
    ).toBeNull();
    expect(
      parseOutreachPolicy({ window: { start: "09:00", end: "17:00", timezone: "Europe/Berlin" } }),
    ).not.toBeNull();
  });

  it("reads zero sends from an empty receipts table", async () => {
    const runtime = createPackTestRuntime({ packId: "complex-operator" });
    const identity = runtime.identity();
    await expect(
      assertOutreachAllowed(runtime.env, identity, "sms.send", { dailyCap: 1 }, new Date()),
    ).resolves.toBeUndefined();
  });
});
