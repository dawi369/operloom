import { describe, expect, it, vi, afterEach } from "vitest";
import {
  assertRuntimeContextBindings,
  assertRuntimeContextReady,
  collectRuntimeContext,
  type RuntimeContextBinding,
} from "./context";
const descriptor = {
  id: "document",
  required: true,
  trust: "untrusted",
  description: "Caller document",
  runtimeBinding: "document.input",
} as const;
const available = () => ({
  status: "available" as const,
  data: { text: "Review this" },
  observedAt: new Date(Date.now() - 10).toISOString(),
  expiresAt: new Date(Date.now() + 10000).toISOString(),
  provenance: [{ reference: "input:document", version: "v1" }],
});
const binding = (resolve: RuntimeContextBinding["resolve"]): RuntimeContextBinding => ({
  id: "document.input",
  version: "1",
  schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  maxAgeMs: 1000,
  timeoutMs: 100,
  resolve,
});
const collect = (
  resolve: RuntimeContextBinding["resolve"],
  required = true,
  signal = new AbortController().signal,
) =>
  collectRuntimeContext({
    descriptors: [{ ...descriptor, required }],
    bindings: [binding(resolve)],
    scope: { userId: "u", workspaceId: "w", agentId: "a" },
    input: { text: "Review this" },
    signal,
  });
afterEach(() => vi.useRealTimers());
describe("scoped context contract", () => {
  it("pins trust, provenance and runtime-clamped expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const evidence = await collect(() => available());
    expect(evidence).toMatchObject({
      status: "ready",
      sources: [{ trust: "untrusted", status: "fresh", expiresAt: "2026-01-01T00:00:00.990Z" }],
    });
    assertRuntimeContextReady(evidence);
    vi.advanceTimersByTime(1000);
    expect(() => assertRuntimeContextReady(evidence)).toThrow("Required context");
  });
  it("records optional missing, stale and invalid sources without promoting trust", async () => {
    const missing = await collect(() => ({ status: "missing" }), false);
    expect(missing).toMatchObject({ status: "ready", sources: [{ status: "missing" }] });
    const stale = await collect(
      () => ({
        ...available(),
        observedAt: "2000-01-01T00:00:00Z",
        expiresAt: "2000-01-02T00:00:00Z",
      }),
      false,
    );
    expect(stale.sources[0]).toMatchObject({ status: "stale", data: { text: "Review this" } });
    const invalid = await collect(() => ({ ...available(), data: { text: 123 } }));
    expect(invalid).toMatchObject({ status: "blocked", sources: [{ status: "invalid" }] });
    expect(invalid.sources[0]?.data).toBeUndefined();
  });
  it("blocks required missing/stale/failed evidence without exposing errors", async () => {
    for (const resolve of [
      () => ({ status: "missing" as const }),
      () => {
        throw new Error("secret-provider-token");
      },
      () => ({ ...available(), observedAt: "2000-01-01T00:00:00Z" }),
    ]) {
      const evidence = await collect(resolve);
      expect(evidence.status).toBe("blocked");
      expect(JSON.stringify(evidence)).not.toContain("secret-provider-token");
      expect(() => assertRuntimeContextReady(evidence)).toThrow("Required context");
    }
  });
  it("bounds resolver deadlines, cancels collection and validates binding coverage", async () => {
    vi.useFakeTimers();
    const pending = collect(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ status: "blocked", sources: [{ status: "failed" }] });
    const controller = new AbortController();
    const aborted = collect(() => new Promise(() => {}), true, controller.signal);
    const rejected = expect(aborted).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await rejected;
    expect(() => assertRuntimeContextBindings([descriptor], [])).toThrow(
      "executable scoped binding",
    );
  });
  it("rejects oversized/non-JSON evidence and freezes caller input", async () => {
    const huge = await collect(() => ({ ...available(), data: { text: "x".repeat(17000) } }));
    expect(huge.sources[0]?.status).toBe("invalid");
    const invalid = await collect(() => ({ ...available(), data: { text: "ok", n: Infinity } }));
    expect(invalid.sources[0]?.status).toBe("invalid");
    const seen = await collect(({ input, scope, state }) => {
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(scope)).toBe(true);
      expect(state).toBeUndefined();
      return available();
    });
    expect(seen.status).toBe("ready");
  });
});
