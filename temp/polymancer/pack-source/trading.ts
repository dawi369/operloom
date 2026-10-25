/** Pure paper-trading math: order books, venue fees, book walks and the price-check verdict. No I/O. */

export type Level = { price: number; size: number };
/** One outcome's book, best level first on each side. */
export type Book = { bids: Level[]; asks: Level[] };
export type FeeModel =
  | { kind: "polymarket"; rate: number; exponent: number }
  | { kind: "kalshi"; multiplier: number; coefficient: number }
  | { kind: "none" };

/** Stop walking when the next level is more than this far above the best ask (or below the best bid). */
export const slippageLimit = 0.02;
/** A price check is valid this long; opening a position needs a fresher one. */
export const quoteValidityMs = 5 * 60_000;
/** Product policy for model error: an edge must clear the executable price by this much. */
export const edgeBuffer = 0.03;
/** Ranges wider than this are not enough evidence for a verdict. */
export const maxRangeWidth = 0.3;
/** Past Kalshi schedules charged takers 0.07 × multiplier × C × P × (1 − P); unverified, so configurable here. */
export const kalshiTakerCoefficient = 0.07;

const round = (value: number, places = 6) => Number(value.toFixed(places));
const levels = (value: unknown, toPrice = (price: number) => price): Level[] =>
  (Array.isArray(value) ? value : []).flatMap((item) => {
    const [price, size] = Array.isArray(item)
      ? item
      : [(item as { price?: unknown })?.price, (item as { size?: unknown })?.size];
    const p = toPrice(Number(price));
    const s = Number(size);
    return p > 0 && p < 1 && s > 0 ? [{ price: round(p), size: s }] : [];
  });
const bestFirst = (bids: Level[], asks: Level[]): Book => ({
  bids: [...bids].sort((left, right) => right.price - left.price),
  asks: [...asks].sort((left, right) => left.price - right.price),
});

/** Polymarket CLOB `/book`: bids ascending and asks descending, best last; one book per outcome token. */
export const polymarketBook = (body: unknown): Book => {
  const record = (body ?? {}) as { bids?: unknown; asks?: unknown };
  return bestFirst(levels(record.bids), levels(record.asks));
};

/** Kalshi lists bids only; a YES ask is 1 − a NO bid, and a NO ask is 1 − a YES bid. */
export const kalshiBooks = (body: unknown): { yes: Book; no: Book } => {
  const book = ((body ?? {}) as { orderbook_fp?: { yes_dollars?: unknown; no_dollars?: unknown } })
    .orderbook_fp;
  const yesBids = levels(book?.yes_dollars);
  const noBids = levels(book?.no_dollars);
  const flip = (side: Level[]) =>
    side.map((level) => ({ ...level, price: round(1 - level.price) }));
  return { yes: bestFirst(yesBids, flip(noBids)), no: bestFirst(noBids, flip(yesBids)) };
};

/** Fee for a taker fill of `shares` at `price`, before any venue rounding. */
const rawFee = (model: FeeModel, shares: number, price: number) => {
  const variance = price * (1 - price);
  if (model.kind === "polymarket") return shares * model.rate * variance ** model.exponent;
  if (model.kind === "kalshi") return model.coefficient * model.multiplier * shares * variance;
  return 0;
};
export const fee = (model: FeeModel, shares: number, price: number) => {
  const value = rawFee(model, shares, price);
  // Kalshi rounds each fee up to the cent.
  return model.kind === "kalshi" ? Math.ceil(value * 100 - 1e-9) / 100 : round(value);
};

export type Fill = {
  shares: number;
  cost: number;
  fees: number;
  vwap: number;
  /** Price per share after fees: "the market after costs". */
  execPrice: number;
  best: number;
  /** True when depth or the slippage limit, not the budget, ended the walk. */
  depthLimited: boolean;
};

/** Buys whole shares up the asks until the budget (cost plus fees) or the slippage limit runs out. */
export const walkBuy = (book: Book, budget: number, model: FeeModel): Fill | null => {
  const best = book.asks[0]?.price;
  if (best === undefined) return null;
  let shares = 0;
  let cost = 0;
  let fees = 0;
  let depthLimited = true;
  for (const level of book.asks) {
    if (level.price > best + slippageLimit + 1e-9) break;
    const remaining = budget - cost - fees;
    let take = Math.min(
      Math.floor(level.size),
      Math.floor(remaining / (level.price + rawFee(model, 1, level.price))),
    );
    // Venue fee rounding can push the last share over budget.
    while (take > 0 && take * level.price + fee(model, take, level.price) > remaining + 1e-9)
      take -= 1;
    if (take > 0) {
      shares += take;
      cost += take * level.price;
      fees += fee(model, take, level.price);
    }
    if (take < Math.floor(level.size)) {
      depthLimited = false;
      break;
    }
  }
  if (!shares) return null;
  return {
    shares,
    cost: round(cost),
    fees: round(fees),
    vwap: round(cost / shares),
    execPrice: round((cost + fees) / shares),
    best,
    depthLimited,
  };
};

/** Sells up to `shares` down the bids within the slippage limit. */
export const walkSell = (book: Book, shares: number, model: FeeModel) => {
  const best = book.bids[0]?.price;
  if (best === undefined) return null;
  let sold = 0;
  let proceeds = 0;
  let fees = 0;
  for (const level of book.bids) {
    if (level.price < best - slippageLimit - 1e-9 || sold >= shares) break;
    const take = Math.min(Math.floor(level.size), shares - sold);
    sold += take;
    proceeds += take * level.price;
    fees += fee(model, take, level.price);
  }
  if (!sold) return null;
  return {
    shares: sold,
    proceeds: round(proceeds),
    fees: round(fees),
    vwap: round(proceeds / sold),
    best,
  };
};

export const mid = (book: Book) => {
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  return bid !== undefined && ask !== undefined ? round((bid + ask) / 2) : undefined;
};

export type Estimate = { low: number; point: number; high: number };
export type Verdict =
  | { code: "not_enough_evidence"; reason: string }
  | { code: "possible_edge"; side: "yes" | "no"; margin: number }
  | { code: "no_edge" };

/**
 * Checked in order: not enough evidence (no brief, low confidence or a range wider than 30
 * points), then a possible edge where the near end of the range clears the executable price
 * by the buffer, then no edge. Prices are per share after costs for the intended size.
 */
export const priceVerdict = (
  brief: { estimate?: Estimate; confidence: string } | null,
  exec: { yes?: number; no?: number },
): Verdict => {
  if (!brief?.estimate) return { code: "not_enough_evidence", reason: "There is no brief yet." };
  if (brief.confidence === "low")
    return { code: "not_enough_evidence", reason: "The brief's confidence is low." };
  const { low, high } = brief.estimate;
  if (high - low > maxRangeWidth + 1e-9)
    return { code: "not_enough_evidence", reason: "The brief's range is wider than 30 points." };
  if (exec.yes !== undefined && low - exec.yes >= edgeBuffer - 1e-9)
    return { code: "possible_edge", side: "yes", margin: round(low - exec.yes) };
  if (exec.no !== undefined && 1 - exec.no - high >= edgeBuffer - 1e-9)
    return { code: "possible_edge", side: "no", margin: round(1 - exec.no - high) };
  return { code: "no_edge" };
};

/** Expected value per share of buying a side at its executable price, for probability `p` of YES. */
export const gap = (p: number, side: "yes" | "no", execPrice: number) =>
  round((side === "yes" ? p : 1 - p) - execPrice);

/** "If it resolves Yes: +$34 paper. If No: −$25 paper." for a held side. */
export const outcomes = (side: "yes" | "no", shares: number, totalCost: number) => {
  const win = round(shares - totalCost, 2);
  const loss = round(-totalCost, 2);
  return side === "yes" ? { ifYes: win, ifNo: loss } : { ifYes: loss, ifNo: win };
};
