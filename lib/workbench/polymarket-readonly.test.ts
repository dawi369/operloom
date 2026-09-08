import { afterEach, describe, expect, it, vi } from "vitest";

import {
  polymarketMarketSearchToolName,
  runPolymarketMarketSearch,
  runPolymarketOrderbookSnapshot,
  validatePolymarketMarketSearchInput,
  validatePolymarketMarketSnapshotInput,
  validatePolymarketOrderbookSnapshotInput,
} from "./polymarket-readonly";

describe("polymarket readonly tools", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects unsupported fields and oversized limits", () => {
    expect(validatePolymarketMarketSearchInput({ query: "fed", url: "http://localhost" })).toEqual(
      expect.objectContaining({
        code: "invalid_input",
        redacted: true,
      }),
    );
    expect(validatePolymarketMarketSearchInput({ query: "fed", limit: 100 })).toEqual(
      expect.objectContaining({
        code: "invalid_input",
        message: "limit must be an integer from 1 to 20.",
      }),
    );
    expect(validatePolymarketMarketSnapshotInput({})).toEqual(
      expect.objectContaining({
        code: "invalid_input",
        message: "marketId or slug is required.",
      }),
    );
    expect(
      validatePolymarketOrderbookSnapshotInput({ tokenId: "https://localhost/private" }),
    ).toEqual(
      expect.objectContaining({
        code: "invalid_input",
      }),
    );
  });

  it("accepts bounded market and order book identifiers", () => {
    expect(validatePolymarketMarketSearchInput({ query: "election", limit: 2 })).toEqual({
      query: "election",
      slug: undefined,
      tagId: undefined,
      limit: 2,
    });
    expect(validatePolymarketMarketSnapshotInput({ slug: "will-example-resolve-yes" })).toEqual({
      slug: "will-example-resolve-yes",
    });
    expect(validatePolymarketOrderbookSnapshotInput({ tokenId: "1234567890" })).toEqual({
      tokenId: "1234567890",
    });
  });

  it("projects search responses without raw provider payload passthrough", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify([
            {
              id: "market-1",
              slug: "fed-rates",
              question: "Will rates fall?",
              active: true,
              closed: false,
              volume: "10",
              liquidity: "5",
              outcomes: '["Yes","No"]',
              outcomePrices: '["0.42","0.58"]',
              clobTokenIds: '["token-yes","token-no"]',
              rawProviderOnly: "must not pass through",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const result = await runPolymarketMarketSearch({ query: "rates", limit: 5 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.output.markets[0]).toEqual({
      id: "market-1",
      slug: "fed-rates",
      question: "Will rates fall?",
      active: true,
      closed: false,
      endDate: undefined,
      volume: "10",
      liquidity: "5",
      outcomes: ["Yes", "No"],
      outcomePrices: ["0.42", "0.58"],
      clobTokenIds: ["token-yes", "token-no"],
    });
    expect(JSON.stringify(result.output)).not.toContain("rawProviderOnly");
  });

  it("projects order book responses into top depth and spread summaries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            market: "0xabc",
            asset_id: "asset-1",
            last_trade_price: "0.52",
            tick_size: "0.01",
            min_order_size: "5",
            bids: [
              { price: "0.49", size: "20", ignored: true },
              { price: "0.50", size: "10" },
            ],
            asks: [
              { price: "0.55", size: "12" },
              { price: "0.53", size: "8" },
            ],
            rawProviderOnly: "must not pass through",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const result = await runPolymarketOrderbookSnapshot({ tokenId: "token-yes" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.output).toMatchObject({
      tokenId: "token-yes",
      bestBid: "0.50",
      bestAsk: "0.53",
      spread: "0.0300",
      bidCount: 2,
      askCount: 2,
      topBids: [
        { price: "0.50", size: "10" },
        { price: "0.49", size: "20" },
      ],
      topAsks: [
        { price: "0.53", size: "8" },
        { price: "0.55", size: "12" },
      ],
    });
    expect(JSON.stringify(result.output)).not.toContain("rawProviderOnly");
  });

  it("returns redacted provider errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 502 })),
    );

    const result = await runPolymarketMarketSearch({ query: "rates", limit: 1 });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "provider_request_failed",
        message: "Provider request failed with HTTP 502.",
        retryable: true,
        redacted: true,
      },
    });
    expect(polymarketMarketSearchToolName).toBe("polymarket.market.search");
  });
});

it("searches the provider catalog and projects active event markets within the result bound", async () => {
  const fetchMock = vi.fn(
    async (_url: URL) =>
      new Response(
        JSON.stringify({
          events: [
            {
              title: "Bitcoin",
              markets: [
                { id: "closed", slug: "old", closed: true },
                {
                  id: "one",
                  slug: "price-target",
                  question: "Above the target?",
                  active: true,
                  closed: false,
                  clobTokenIds: '["123"]',
                },
                { id: "two", slug: "second-target", active: true, closed: false },
              ],
            },
          ],
          profiles: [{ private: "excluded" }],
        }),
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  try {
    const result = await runPolymarketMarketSearch({ query: "Bitcoin", limit: 1 });
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/public-search");
    expect(url.searchParams.get("q")).toBe("Bitcoin");
    expect(result.ok && result.output.markets.map((market) => market.id)).toEqual(["one"]);
  } finally {
    vi.unstubAllGlobals();
  }
});
