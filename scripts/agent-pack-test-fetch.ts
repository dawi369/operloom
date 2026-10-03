const polymarketFixture = {
  id: "market-conformance-1",
  conditionId: "0xconformance-condition",
  slug: "gta-vi-launch-before-2027",
  question: "Will GTA VI launch before 2027?",
  description:
    "Resolves Yes if Grand Theft Auto VI is released to the public before January 1, 2027, 12:00 AM ET. Otherwise No.",
  resolutionSource: "Official Rockstar Games announcements",
  endDate: "2026-12-31T12:00:00Z",
  active: true,
  closed: false,
  volume: "100000",
  liquidity: "25000",
  outcomes: ["Yes", "No"],
  outcomePrices: ["0.62", "0.38"],
  clobTokenIds: ["conformance-token-yes", "conformance-token-no"],
};
// A later, far-dated sibling so search results hold contracts with different deadlines.
const polymarketLaterFixture = {
  ...polymarketFixture,
  id: "market-conformance-2",
  conditionId: "0xconformance-condition-2031",
  slug: "gta-vi-launch-before-2031",
  question: "Will GTA VI launch before 2031?",
  description:
    "Resolves Yes if Grand Theft Auto VI is released to the public before January 1, 2031, 12:00 AM ET. Otherwise No.",
  endDate: "2030-12-31T12:00:00Z",
  outcomePrices: ["0.9", "0.1"],
  clobTokenIds: ["conformance-token-2031-yes", "conformance-token-2031-no"],
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/**
 * Agent-pack tests are deterministic and must not make provider requests.
 * Public provider smokes remain separate, opt-in commands.
 */
export const createAgentPackTestFetch = (): typeof fetch => async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === "https://gamma-api.polymarket.com" && url.pathname === "/public-search") {
    return json({ events: [{ markets: [polymarketFixture, polymarketLaterFixture] }] });
  }
  if (url.origin === "https://gamma-api.polymarket.com" && url.pathname === "/markets") {
    return json([polymarketFixture]);
  }
  if (url.origin === "https://clob.polymarket.com" && url.pathname === "/book") {
    return json({
      market: polymarketFixture.id,
      asset_id: url.searchParams.get("token_id"),
      last_trade_price: "0.61",
      tick_size: "0.01",
      min_order_size: "5",
      bids: [
        { price: "0.60", size: "100" },
        { price: "0.59", size: "80" },
      ],
      asks: [
        { price: "0.62", size: "90" },
        { price: "0.63", size: "75" },
      ],
    });
  }
  throw new Error(`Agent-pack test attempted unexpected external request: ${url.origin}`);
};
