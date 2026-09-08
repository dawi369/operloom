import { afterEach, expect, it, vi } from "vitest";
import { fetchWithTimeout } from "./transport";

vi.mock("@/lib/workbench/agent-identity", () => ({ getWorkbenchIdentityHeaders: vi.fn() }));
vi.mock("@/lib/workbench/control-plane-signing", () => ({ signFacadeRequest: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("allows a cold workflow response beyond the normal request deadline", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url, init) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response("ok")), 20_000);
          init.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    ),
  );
  const workflow = fetchWithTimeout("https://example.test", {}, 45_000);
  const ordinary = expect(fetchWithTimeout("https://example.test", {})).rejects.toThrow("10000ms");
  await vi.advanceTimersByTimeAsync(20_000);
  await ordinary;
  expect((await workflow).status).toBe(200);
  expect(vi.getTimerCount()).toBe(0);
});
