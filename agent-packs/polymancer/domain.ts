/** Pure Polymancer domain logic, ported from the original backend. No I/O. */

export type Side = "yes" | "no";
export type OrderType = "buy" | "sell";

export const roundToSix = (value: number) => Number(value.toFixed(6));
export const startingCashUsd = 1000;

export type PositionState = {
  marketId: string;
  question: string;
  side: Side;
  shares: number;
  avgEntryPrice: number;
  currentPrice: number;
};
export type PaperOrder = {
  marketId: string;
  question: string;
  side: Side;
  orderType: OrderType;
  sizeUsd: number;
  price: number;
};
export type PaperFill = {
  marketId: string;
  question: string;
  side: Side;
  orderType: OrderType;
  fillPrice: number;
  shares: number;
  notionalUsd: number;
};

/** State keys must be identifiers; market ids are condition ids or slugs. */
export const positionKey = (marketId: string, side: Side) => `${marketId}:${side}`;

/** Deterministic paper fill at the order price; sells never exceed held shares. */
export const paperFill = (order: PaperOrder, heldShares = 0): PaperFill | null => {
  const fillPrice = roundToSix(order.price);
  const requested = roundToSix(order.sizeUsd / Math.max(fillPrice, 0.01));
  const shares = order.orderType === "sell" ? Math.min(requested, heldShares) : requested;
  if (!(shares > 0)) return null;
  return {
    marketId: order.marketId,
    question: order.question,
    side: order.side,
    orderType: order.orderType,
    fillPrice,
    shares,
    notionalUsd: roundToSix(shares * fillPrice),
  };
};

/** Buys re-average the entry price; sells keep it; a fully sold position closes. */
export const applyFill = (
  position: PositionState | null,
  fill: PaperFill,
): PositionState | null => {
  const shares = position?.shares ?? 0;
  const avgEntryPrice = position?.avgEntryPrice ?? 0;
  if (fill.orderType === "buy") {
    const nextShares = roundToSix(shares + fill.shares);
    return {
      marketId: fill.marketId,
      question: fill.question,
      side: fill.side,
      shares: nextShares,
      avgEntryPrice: roundToSix(
        (shares * avgEntryPrice + fill.shares * fill.fillPrice) / nextShares,
      ),
      currentPrice: fill.fillPrice,
    };
  }
  const nextShares = roundToSix(shares - fill.shares);
  return position && nextShares > 0
    ? { ...position, shares: nextShares, currentPrice: fill.fillPrice }
    : null;
};

export const markPosition = (position: PositionState) => ({
  ...position,
  marketValueUsd: roundToSix(position.shares * position.currentPrice),
  costBasisUsd: roundToSix(position.shares * position.avgEntryPrice),
  unrealizedPnlUsd: roundToSix((position.currentPrice - position.avgEntryPrice) * position.shares),
});

export const exposureUsd = (positions: readonly PositionState[]) =>
  roundToSix(
    positions.reduce((total, position) => total + position.shares * position.currentPrice, 0),
  );

export type RiskLimits = { maxPositionUsd: number; maxOpenPositions: number };
export type RiskCheck = { ok: true } | { ok: false; code: string; message: string };

/** Buys must fit cash, the per-position cost cap and the open-position cap; sells always reduce risk. */
export const checkRisk = (input: {
  fill: PaperFill;
  next: PositionState | null;
  opensPosition: boolean;
  openPositions: number;
  cashUsd: number;
  limits: RiskLimits;
}): RiskCheck => {
  if (input.fill.orderType === "sell") return { ok: true };
  if (input.fill.notionalUsd > input.cashUsd)
    return {
      ok: false,
      code: "insufficient_cash",
      message: "Paper cash does not cover the order.",
    };
  if (
    input.next &&
    input.next.shares * input.next.avgEntryPrice > input.limits.maxPositionUsd + 1e-9
  )
    return {
      ok: false,
      code: "max_position_exceeded",
      message: `The position would exceed ${input.limits.maxPositionUsd} USD.`,
    };
  if (input.opensPosition && input.openPositions >= input.limits.maxOpenPositions)
    return {
      ok: false,
      code: "max_open_positions",
      message: `At most ${input.limits.maxOpenPositions} positions may be open.`,
    };
  return { ok: true };
};

export type HeartbeatThresholds = { priceMoveAbs: number; exposureMovePct: number };
export const defaultHeartbeatThresholds: HeartbeatThresholds = {
  priceMoveAbs: 0.05,
  exposureMovePct: 0.1,
};
export type MarketQuote = { marketId: string; question: string; yesPrice: number; noPrice: number };
export type HeartbeatSnapshot = {
  positions: readonly { marketId: string; side: Side; currentPrice: number }[];
  markets: readonly MarketQuote[];
  totalExposureUsd: number;
};
export type HeartbeatChange = {
  type: "position_price_move" | "watched_market_price_move" | "exposure_move";
  marketId?: string;
  side?: Side;
  previous: number;
  current: number;
  delta: number;
  threshold: number;
};

/** Material when any position or watched price moves by `priceMoveAbs` or exposure by `exposureMovePct`. */
export const evaluateHeartbeat = (
  previous: HeartbeatSnapshot | null,
  current: HeartbeatSnapshot,
  thresholds: HeartbeatThresholds = defaultHeartbeatThresholds,
): { status: "noop" | "material"; changes: HeartbeatChange[] } => {
  if (!previous) return { status: "noop", changes: [] };
  const changes: HeartbeatChange[] = [];
  const priorPositions = new Map(
    previous.positions.map((position) => [positionKey(position.marketId, position.side), position]),
  );
  for (const position of current.positions) {
    const prior = priorPositions.get(positionKey(position.marketId, position.side));
    if (!prior) continue;
    const delta = roundToSix(position.currentPrice - prior.currentPrice);
    if (Math.abs(delta) >= thresholds.priceMoveAbs)
      changes.push({
        type: "position_price_move",
        marketId: position.marketId,
        side: position.side,
        previous: prior.currentPrice,
        current: position.currentPrice,
        delta,
        threshold: thresholds.priceMoveAbs,
      });
  }
  const priorMarkets = new Map(previous.markets.map((market) => [market.marketId, market]));
  for (const market of current.markets) {
    const prior = priorMarkets.get(market.marketId);
    if (!prior) continue;
    for (const side of ["yes", "no"] as const) {
      const before = side === "yes" ? prior.yesPrice : prior.noPrice;
      const after = side === "yes" ? market.yesPrice : market.noPrice;
      const delta = roundToSix(after - before);
      if (Math.abs(delta) >= thresholds.priceMoveAbs)
        changes.push({
          type: "watched_market_price_move",
          marketId: market.marketId,
          side,
          previous: before,
          current: after,
          delta,
          threshold: thresholds.priceMoveAbs,
        });
    }
  }
  if (previous.totalExposureUsd > 0) {
    const delta = roundToSix(current.totalExposureUsd - previous.totalExposureUsd);
    if (Math.abs(delta) / previous.totalExposureUsd >= thresholds.exposureMovePct)
      changes.push({
        type: "exposure_move",
        previous: previous.totalExposureUsd,
        current: current.totalExposureUsd,
        delta,
        threshold: thresholds.exposureMovePct,
      });
  }
  return { status: changes.length ? "material" : "noop", changes };
};

/** One row of `GET https://data-api.polymarket.com/activity`. */
export type WalletActivity = {
  proxyWallet?: string | null;
  timestamp: number | string;
  type: string;
  size?: number | string | null;
  usdcSize?: number | string | null;
  transactionHash?: string | null;
  price?: number | string | null;
  asset?: string | null;
  side?: string | null;
  outcomeIndex?: number | string | null;
  title?: string | null;
  slug?: string | null;
  outcome?: string | null;
  conditionId?: string | null;
};

export const activityUrl = (wallet: string) =>
  `https://data-api.polymarket.com/activity?${new URLSearchParams({
    user: wallet,
    limit: "100",
    offset: "0",
    sortDirection: "DESC",
    sortBy: "TIMESTAMP",
  })}`;

/** The dedupe identity of one wallet event. */
export const activityEventKey = (activity: WalletActivity) =>
  activity.transactionHash
    ? `tx:${activity.transactionHash}:${activity.type}:${activity.asset}:${activity.side}:${activity.timestamp}`
    : `synthetic:${activity.type}:${activity.conditionId}:${activity.asset}:${activity.side}:${activity.outcomeIndex}:${activity.price}:${activity.size}:${activity.timestamp}`;

/** Unix seconds, milliseconds or ISO strings to an ISO timestamp. */
export const activityTime = (activity: WalletActivity) => {
  const value = activity.timestamp;
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(numeric))
    return new Date(numeric < 1e12 ? numeric * 1000 : numeric).toISOString();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const numberOf = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export type CopyTranslation =
  | { ok: true; order: PaperOrder }
  | { ok: false; code: string; message: string };

/** A tracked wallet TRADE becomes a same-side paper order sized at the source notional. */
export const translateActivity = (activity: WalletActivity): CopyTranslation => {
  const fail = (code: string, message: string): CopyTranslation => ({ ok: false, code, message });
  if (activity.type !== "TRADE")
    return fail("unsupported_event_type", "Only TRADE wallet activity can be mirrored.");
  const marketId = activity.conditionId ?? activity.slug;
  if (!marketId || !activity.title)
    return fail("market_id_missing", "Wallet activity must include market metadata.");
  const orderType = activity.side === "BUY" ? "buy" : activity.side === "SELL" ? "sell" : null;
  if (!orderType) return fail("order_type_invalid", "Wallet activity must be a BUY or SELL.");
  const outcome = activity.outcome?.trim().toLowerCase();
  const index = numberOf(activity.outcomeIndex);
  const side: Side | null =
    outcome === "yes" || (!outcome && index === 0)
      ? "yes"
      : outcome === "no" || (!outcome && index === 1)
        ? "no"
        : null;
  if (!side)
    return fail("outcome_side_invalid", "Wallet activity must resolve to a yes or no side.");
  const price = numberOf(activity.price);
  if (price === null || price <= 0 || price >= 1)
    return fail("price_invalid", "Wallet activity must include a price between 0 and 1.");
  const size = numberOf(activity.size);
  const notional = numberOf(activity.usdcSize) ?? (size === null ? null : size * price);
  if (notional === null || notional <= 0)
    return fail("notional_usd_invalid", "Wallet activity must include a positive notional.");
  return {
    ok: true,
    order: {
      marketId,
      question: activity.title,
      side,
      orderType,
      sizeUsd: roundToSix(notional),
      price,
    },
  };
};

export const isWalletAddress = (value: string) => /^0x[0-9a-fA-F]{40}$/.test(value);

/** `start copy trading 0x…` from chat. */
export const parseCopyCommand = (text: string) => {
  const match = /^start copy trading\s+(\S+)\s*$/i.exec(text.trim());
  if (!match) return { matched: false as const };
  return { matched: true as const, walletAddress: match[1]!, valid: isWalletAddress(match[1]!) };
};
