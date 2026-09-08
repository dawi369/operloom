import { describe, expect, it, vi } from "vitest";

import { createAgentPackTestFetch } from "./agent-pack-test-fetch";
import { runAgentPackConformance } from "./test-agent-pack";

describe("agent-pack deterministic fetch", () => {
  it("serves bounded Polymarket fixtures without provider traffic", async () => {
    const fetchFixture = createAgentPackTestFetch();
    const markets = await fetchFixture(
      "https://gamma-api.polymarket.com/markets?active=true&limit=5",
    );
    const book = await fetchFixture(
      "https://clob.polymarket.com/book?token_id=conformance-token-yes",
    );

    await expect(markets.json()).resolves.toEqual([
      expect.objectContaining({
        slug: "gta-vi-launch-before-2027",
        clobTokenIds: ["conformance-token-yes", "conformance-token-no"],
      }),
    ]);
    await expect(book.json()).resolves.toEqual(
      expect.objectContaining({ asset_id: "conformance-token-yes" }),
    );
  });

  it("executes Polymancer conformance against the deterministic provider fixtures", async () => {
    vi.stubGlobal("fetch", createAgentPackTestFetch());
    try {
      const report = await runAgentPackConformance(process.cwd(), "baby-polymancer");
      expect(report.ok).toBe(true);
      expect(report.results).toContainEqual(
        expect.objectContaining({
          id: "workflow.polymancer.market_research",
          ok: true,
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails closed on undeclared external requests", async () => {
    await expect(createAgentPackTestFetch()("https://example.com/data")).rejects.toThrow(
      "unexpected external request",
    );
  });
});
