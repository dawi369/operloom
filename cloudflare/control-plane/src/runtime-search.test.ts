import { afterEach, describe, expect, it, vi } from "vitest";

import { createPackTestRuntime } from "./pack-test-runtime";
import { createRuntimeSearchPort, withinWindow } from "./runtime-search";
import type { Env } from "./types";

const runtimes: ReturnType<typeof createPackTestRuntime>[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const runtime of runtimes.splice(0)) runtime.close();
});
const start = () => {
  const runtime = createPackTestRuntime({ packId: "resource-allocator" });
  runtimes.push(runtime);
  runtime.db
    .prepare(
      `INSERT INTO control_runs (id,user_id,workspace_id,agent_id,workflow_intent_id,status,execution_json,data_json,created_at,updated_at)
       VALUES ('run','user','ws-user','agent-user','intent','running','{}','{}','now','now')`,
    )
    .run();
  return runtime;
};
const port = (runtime: ReturnType<typeof start>, env: Env = runtime.env) =>
  createRuntimeSearchPort(env, runtime.identity(), {
    runId: "run",
    packId: "resource-allocator",
    signal: new AbortController().signal,
  });
const cutoff = "2026-09-01T00:00:00.000Z";

describe("runtime search port", () => {
  it("returns dated fixture results inside the cutoff and replays by operation key", async () => {
    const runtime = start();
    const first = await port(runtime).web({
      idempotencyKey: "brief-1.base-rate",
      query: "fed rate cuts",
      maxResults: 5,
      publishedBefore: cutoff,
    });
    expect(first.source).toBe("fixture");
    expect(first.results).toHaveLength(3);
    for (const result of first.results)
      expect(Date.parse(result.publishedAt!)).toBeLessThanOrEqual(Date.parse(cutoff));
    expect(
      await port(runtime).web({
        idempotencyKey: "brief-1.base-rate",
        query: "fed rate cuts",
        maxResults: 5,
        publishedBefore: cutoff,
      }),
    ).toEqual(first);
    await expect(
      port(runtime).web({ idempotencyKey: "brief-1.base-rate", query: "something else" }),
    ).rejects.toMatchObject({ code: "usage_key_conflict" });
  });

  it("calls the provider with the window, drops undated and late results and keeps the key private", async () => {
    const runtime = start();
    const requests: { headers: Headers; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      requests.push({
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return Response.json({
        results: [
          { url: "https://a.example/1", title: "Dated", publishedDate: "2026-08-20", text: "A" },
          { url: "https://a.example/2", title: "Undated", text: "B" },
          { url: "https://a.example/3", title: "Late", publishedDate: "2026-09-20", text: "C" },
          { url: "javascript:alert(1)", title: "Bad", publishedDate: "2026-08-01" },
        ],
      });
    });
    const env = { ...runtime.env, OPERLOOM_E2E_MODE: "false", EXA_API_KEY: "exa-secret" } as Env;
    const response = await port(runtime, env).web({
      idempotencyKey: "brief-2.for",
      query: "fed rate cuts",
      publishedBefore: cutoff,
    });
    expect(requests[0]!.headers.get("x-api-key")).toBe("exa-secret");
    expect(requests[0]!.body).toMatchObject({ query: "fed rate cuts", endPublishedDate: cutoff });
    expect(response).toMatchObject({
      provider: "exa",
      source: "provider",
      results: [{ id: "r1", url: "https://a.example/1", title: "Dated", excerpt: "A" }],
    });
    expect(JSON.stringify(response)).not.toContain("exa-secret");
  });

  it("fails closed without a provider key outside the local fixture", async () => {
    const runtime = start();
    const env = { ...runtime.env, OPERLOOM_E2E_MODE: "false" } as Env;
    await expect(
      port(runtime, env).web({ idempotencyKey: "brief-3", query: "anything" }),
    ).rejects.toMatchObject({ code: "search_provider_unconfigured" });
    await expect(
      port(runtime).web({ idempotencyKey: "bad key!", query: "anything" }),
    ).rejects.toMatchObject({ code: "search_request_invalid" });
  });

  it("keeps undated results when only a lower bound is set", () => {
    const results = [
      { id: "a", url: "https://x/a", title: "a", excerpt: "" },
      { id: "b", url: "https://x/b", title: "b", excerpt: "", publishedAt: "2026-01-01T00:00:00Z" },
    ];
    expect(withinWindow(results, { publishedAfter: "2026-06-01T00:00:00Z" })).toEqual([results[0]]);
    expect(withinWindow(results, { publishedBefore: "2026-06-01T00:00:00Z" })).toEqual([
      results[1],
    ]);
  });
});
