import { describe, expect, it } from "vitest";

import { monitorCursorState, monitorFingerprint, observeMonitor } from "./monitor.js";
import type { RuntimeStateRecord } from "./state.js";

const store = (records: RuntimeStateRecord[] = []) => ({
  async get(key: { namespace: string; kind: string; key: string }) {
    return (
      records.find(
        (record) =>
          record.namespace === key.namespace && record.kind === key.kind && record.key === key.key,
      ) ?? null
    );
  },
});

describe("monitor observations", () => {
  it("fingerprints equal observations identically regardless of key order", async () => {
    const first = await monitorFingerprint({ price: 0.42, market: { id: "m", open: true } });
    const second = await monitorFingerprint({ market: { open: true, id: "m" }, price: 0.42 });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(await monitorFingerprint({ price: 0.43, market: { id: "m", open: true } })).not.toBe(
      first,
    );
  });

  it("acts once per distinct observation and fences the cursor read", async () => {
    const fingerprint = await monitorFingerprint({ level: 3 });
    const first = await observeMonitor(store(), {
      namespace: "capacity",
      key: "pool",
      fingerprint,
      observedAt: "2026-07-01T00:00:00.000Z",
    });
    expect(first).toMatchObject({ changed: true, previousFingerprint: null });
    expect(first.commit.reads).toEqual([
      { namespace: "capacity", kind: "monitor.cursor", key: "pool", version: 0 },
    ]);
    expect(first.commit.writes).toEqual([
      {
        namespace: "capacity",
        kind: "monitor.cursor",
        key: "pool",
        schemaVersion: 1,
        data: { fingerprint, observedAt: "2026-07-01T00:00:00.000Z" },
      },
    ]);

    const recorded = store([
      {
        namespace: "capacity",
        kind: "monitor.cursor",
        key: "pool",
        version: 4,
        schemaVersion: 1,
        data: { fingerprint, observedAt: "2026-07-01T00:00:00.000Z" },
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
    const repeated = await observeMonitor(recorded, {
      namespace: "capacity",
      key: "pool",
      fingerprint,
      observedAt: "2026-07-01T00:01:00.000Z",
    });
    expect(repeated).toMatchObject({ changed: false, previousFingerprint: fingerprint });
    expect(repeated.commit).toEqual({
      reads: [{ namespace: "capacity", kind: "monitor.cursor", key: "pool", version: 4 }],
      writes: [],
    });
  });

  it("declares a bounded cursor state kind and rejects oversized fingerprints", async () => {
    expect(monitorCursorState("capacity")).toMatchObject({
      namespace: "capacity",
      kind: "monitor.cursor",
      schemaVersion: 1,
    });
    await expect(
      observeMonitor(store(), {
        namespace: "capacity",
        key: "pool",
        fingerprint: "x".repeat(129),
        observedAt: "now",
      }),
    ).rejects.toThrow("1-128 characters");
  });
});
