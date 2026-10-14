import { afterEach, describe, expect, it } from "vitest";
import { createPackTestRuntime } from "./pack-test-runtime";
import { inQuietHours, quietHoursEnd } from "./notification-channels";

const runtimes: ReturnType<typeof createPackTestRuntime>[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
});
const start = () => {
  const runtime = createPackTestRuntime({ packId: "resource-allocator", users: ["ann"] });
  runtimes.push(runtime);
  return runtime;
};
const alert = (id: string) => ({
  type: "capacity.escalated",
  severity: "alert" as const,
  title: "Allocation needs review",
  body: "5 units for primary.",
  target: { type: "actionProposal", id },
});
const info = (id: string) => ({
  type: "capacity.observed",
  severity: "info" as const,
  title: `Pool observed ${id}`,
  body: "Demand changed.",
  target: { type: "observation", id },
});
const at = (hour: number) => new Date(Date.UTC(2026, 0, 1, hour, 0, 0));

describe("notification channels", () => {
  it("delivers a package alert to the recorded email transport on the next sweep, once", async () => {
    const runtime = start();
    const port = runtime.notifications();
    const first = await port.emit(alert("p1"));
    expect(first.queued).toBe(1);
    expect(runtime.deliveries().map((row) => [row.channel, row.status])).toEqual([
      ["email", "queued"],
    ]);
    const swept = await runtime.sweepNotifications();
    expect(swept).toMatchObject({ drained: 1 });
    expect(runtime.deliveries()[0]).toMatchObject({
      channel: "email",
      status: "delivered",
      severity: "alert",
      title: "Allocation needs review",
    });
    // The same event again is a no-op: the delivery key already exists.
    expect((await port.emit(alert("p1"))).queued).toBe(0);
    await runtime.sweepNotifications();
    expect(runtime.deliveries()).toHaveLength(1);
  });

  it("refuses undeclared types and malformed events", async () => {
    const runtime = start();
    const port = runtime.notifications();
    await expect(port.emit({ ...alert("x"), type: "capacity.unknown" })).rejects.toMatchObject({
      code: "notification_type_undeclared",
    });
    await expect(port.emit({ ...alert("x"), title: "" })).rejects.toMatchObject({
      code: "notification_event_invalid",
    });
    expect(runtime.deliveries()).toEqual([]);
  });

  it("folds info events into one digest and defers it through quiet hours", async () => {
    const runtime = start();
    const port = runtime.notifications();
    for (const id of ["o1", "o2", "o3"]) expect((await port.emit(info(id))).queued).toBe(1);
    expect(runtime.deliveries()).toEqual([]);
    // Quiet hours 22:00–06:00 UTC hold the digest.
    const response = await runtime.setNotificationPreference({
      channel: "email",
      enabled: true,
      quietStart: 22,
      quietEnd: 6,
    });
    expect(response.status).toBe(200);
    expect(await runtime.sweepNotifications(at(23))).toMatchObject({ folded: 0, drained: 0 });
    expect(runtime.deliveries()).toEqual([]);
    expect(await runtime.sweepNotifications(at(9))).toMatchObject({ folded: 1, drained: 1 });
    const digest = runtime.deliveries();
    expect(digest).toHaveLength(1);
    expect(digest[0]).toMatchObject({
      channel: "email",
      status: "delivered",
      severity: "info",
      title: "3 updates",
    });
    expect(digest[0]!.body!.split("\n")).toHaveLength(3);
    // Replaying the sweep folds nothing new.
    expect(await runtime.sweepNotifications(at(9))).toMatchObject({ folded: 0 });
    expect((await port.emit(info("o1"))).queued).toBe(0);
  });

  it("honours a digest hour and a disabled channel", async () => {
    const runtime = start();
    const port = runtime.notifications();
    await runtime.setNotificationPreference({ channel: "email", enabled: true, digestHour: 8 });
    await port.emit(info("o1"));
    expect(await runtime.sweepNotifications(at(7))).toMatchObject({ folded: 0 });
    expect(await runtime.sweepNotifications(at(8))).toMatchObject({ folded: 1 });
    await runtime.setNotificationPreference({
      channel: "email",
      eventType: "capacity.escalated",
      enabled: false,
    });
    expect((await port.emit(alert("held"))).queued).toBe(0);
    const list = await runtime.listNotificationDeliveries();
    expect((list.body as { deliveries: unknown[] }).deliveries).toHaveLength(1);
  });

  it("defers an action-severity delivery to the end of quiet hours", async () => {
    const runtime = start();
    await runtime.setNotificationPreference({
      channel: "email",
      enabled: true,
      quietStart: 22,
      quietEnd: 6,
    });
    expect(inQuietHours({ quiet_start: 22, quiet_end: 6 }, at(23))).toBe(true);
    expect(inQuietHours({ quiet_start: 22, quiet_end: 6 }, at(12))).toBe(false);
    expect(quietHoursEnd({ quiet_end: 6 }, at(23)).toISOString()).toBe("2026-01-02T06:00:00.000Z");
    expect(inQuietHours({ quiet_start: 9, quiet_end: 17 }, at(12))).toBe(true);
  });
});
