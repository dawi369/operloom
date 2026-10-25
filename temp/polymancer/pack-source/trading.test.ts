import { describe, expect, it } from "vitest";

import {
  fee,
  gap,
  kalshiBooks,
  mid,
  outcomes,
  polymarketBook,
  priceVerdict,
  walkBuy,
  walkSell,
  type Book,
} from "./trading";

const none = { kind: "none" } as const;
const book = (asks: [number, number][], bids: [number, number][] = []): Book => ({
  asks: asks.map(([price, size]) => ({ price, size })),
  bids: bids.map(([price, size]) => ({ price, size })),
});

describe("order books", () => {
  it("normalizes Polymarket books best level first", () => {
    expect(
      polymarketBook({
        bids: [
          { price: "0.40", size: "50" },
          { price: "0.43", size: "100" },
        ],
        asks: [
          { price: "0.50", size: "20" },
          { price: "0.45", size: "100" },
        ],
      }),
    ).toEqual(
      book(
        [
          [0.45, 100],
          [0.5, 20],
        ],
        [
          [0.43, 100],
          [0.4, 50],
        ],
      ),
    );
  });

  it("derives Kalshi asks from the opposite side's bids", () => {
    const books = kalshiBooks({
      orderbook_fp: {
        yes_dollars: [
          ["0.30", "10"],
          ["0.35", "5"],
        ],
        no_dollars: [
          ["0.55", "8"],
          ["0.60", "4"],
        ],
      },
    });
    expect(books.yes).toEqual(
      book(
        [
          [0.4, 4],
          [0.45, 8],
        ],
        [
          [0.35, 5],
          [0.3, 10],
        ],
      ),
    );
    expect(books.no).toEqual(
      book(
        [
          [0.65, 5],
          [0.7, 10],
        ],
        [
          [0.6, 4],
          [0.55, 8],
        ],
      ),
    );
    expect(mid(books.yes)).toBe(0.375);
  });
});

describe("fills and fees", () => {
  it("computes Polymarket and Kalshi taker fees", () => {
    expect(fee({ kind: "polymarket", rate: 0.02, exponent: 1 }, 100, 0.5)).toBe(0.5);
    expect(fee({ kind: "kalshi", multiplier: 1, coefficient: 0.07 }, 10, 0.5)).toBe(0.18);
  });

  it("walks asks until the budget runs out", () => {
    expect(walkBuy(book([[0.45, 100]]), 25, none)).toEqual({
      shares: 55,
      cost: 24.75,
      fees: 0,
      vwap: 0.45,
      execPrice: 0.45,
      best: 0.45,
      depthLimited: false,
    });
  });

  it("stops at the slippage limit and reports the depth-limited size", () => {
    const fill = walkBuy(
      book([
        [0.45, 10],
        [0.46, 10],
        [0.48, 100],
      ]),
      100,
      none,
    );
    expect(fill).toMatchObject({ shares: 20, cost: 9.1, vwap: 0.455, depthLimited: true });
    expect(walkBuy(book([]), 100, none)).toBeNull();
  });

  it("keeps rounded Kalshi fees inside the budget", () => {
    const fill = walkBuy(book([[0.5, 1000]]), 10, {
      kind: "kalshi",
      multiplier: 1,
      coefficient: 0.07,
    })!;
    expect(fill.cost + fill.fees).toBeLessThanOrEqual(10);
    expect(fill.shares).toBe(19);
  });

  it("sells down the bids within the slippage limit", () => {
    expect(
      walkSell(
        book(
          [],
          [
            [0.53, 100],
            [0.5, 50],
          ],
        ),
        44,
        none,
      ),
    ).toEqual({
      shares: 44,
      proceeds: 23.32,
      fees: 0,
      vwap: 0.53,
      best: 0.53,
    });
    expect(
      walkSell(
        book(
          [],
          [
            [0.53, 10],
            [0.5, 50],
          ],
        ),
        44,
        none,
      ),
    ).toMatchObject({ shares: 10 });
  });

  it("reports both outcomes of a paper position", () => {
    expect(outcomes("no", 44, 24.64)).toEqual({ ifYes: -24.64, ifNo: 19.36 });
    expect(gap(0.4, "no", 0.56)).toBe(0.04);
  });
});

describe("price verdict", () => {
  const brief = (low: number, point: number, high: number, confidence = "medium") => ({
    estimate: { low, point, high },
    confidence,
  });
  it("needs a confident, narrow brief", () => {
    expect(priceVerdict(null, { yes: 0.5 }).code).toBe("not_enough_evidence");
    expect(priceVerdict(brief(0.6, 0.65, 0.7, "low"), { yes: 0.5 }).code).toBe(
      "not_enough_evidence",
    );
    expect(priceVerdict(brief(0.3, 0.5, 0.7), { yes: 0.2 }).code).toBe("not_enough_evidence");
  });

  it("finds an edge only when the near end of the range clears the buffer", () => {
    expect(priceVerdict(brief(0.6, 0.65, 0.7), { yes: 0.55, no: 0.47 })).toEqual({
      code: "possible_edge",
      side: "yes",
      margin: 0.05,
    });
    expect(priceVerdict(brief(0.3, 0.35, 0.4), { yes: 0.62, no: 0.55 })).toEqual({
      code: "possible_edge",
      side: "no",
      margin: 0.05,
    });
    expect(priceVerdict(brief(0.6, 0.65, 0.7), { yes: 0.58, no: 0.44 })).toEqual({
      code: "no_edge",
    });
  });
});
