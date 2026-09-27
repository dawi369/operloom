import { describe, expect, it } from "vitest";

import {
  activityEventKey,
  activityTime,
  applyFill,
  checkRisk,
  evaluateHeartbeat,
  paperFill,
  parseCopyCommand,
  translateActivity,
  type PaperOrder,
  type WalletActivity,
} from "./domain";

const order = (input: Partial<PaperOrder> = {}): PaperOrder => ({
  marketId: "market-1",
  question: "Will it happen?",
  side: "yes",
  orderType: "buy",
  sizeUsd: 25,
  price: 0.5,
  ...input,
});
const trade = (input: Partial<WalletActivity> = {}): WalletActivity => ({
  proxyWallet: "0x1111111111111111111111111111111111111111",
  timestamp: 1767225600,
  type: "TRADE",
  size: 15,
  usdcSize: 9.3,
  transactionHash: "0xabc",
  price: 0.62,
  asset: "token-yes",
  side: "BUY",
  outcomeIndex: 0,
  title: "Will it happen?",
  outcome: "Yes",
  conditionId: "0xcondition",
  ...input,
});

describe("paper fills", () => {
  it("fills $25 at 0.5 as 50 shares and re-averages entries", () => {
    const fill = paperFill(order())!;
    expect(fill).toMatchObject({ shares: 50, fillPrice: 0.5, notionalUsd: 25 });
    const opened = applyFill(null, fill)!;
    expect(opened).toMatchObject({ shares: 50, avgEntryPrice: 0.5 });
    const doubled = applyFill(opened, paperFill(order())!)!;
    expect(doubled).toMatchObject({ shares: 100, avgEntryPrice: 0.5 });
    const averaged = applyFill(opened, paperFill(order({ sizeUsd: 30, price: 0.6 }))!)!;
    expect(averaged).toMatchObject({ shares: 100, avgEntryPrice: 0.55 });
  });

  it("sells $10 at 0.5 from 50 shares, keeps the entry and closes at zero", () => {
    const opened = applyFill(null, paperFill(order())!)!;
    const sold = applyFill(opened, paperFill(order({ orderType: "sell", sizeUsd: 10 }), 50)!)!;
    expect(sold).toMatchObject({ shares: 30, avgEntryPrice: 0.5 });
    const all = paperFill(order({ orderType: "sell", sizeUsd: 100 }), 30)!;
    expect(all.shares).toBe(30);
    expect(applyFill(sold, all)).toBeNull();
    expect(paperFill(order({ orderType: "sell" }), 0)).toBeNull();
  });

  it("enforces cash, position size and open-position limits on buys only", () => {
    const fill = paperFill(order({ sizeUsd: 60 }))!;
    const limits = { maxPositionUsd: 50, maxOpenPositions: 1 };
    const base = { fill, next: applyFill(null, fill), opensPosition: true, cashUsd: 1000, limits };
    expect(checkRisk({ ...base, openPositions: 0 })).toMatchObject({
      code: "max_position_exceeded",
    });
    expect(checkRisk({ ...base, cashUsd: 10, openPositions: 0 })).toMatchObject({
      code: "insufficient_cash",
    });
    const small = paperFill(order({ sizeUsd: 10 }))!;
    expect(
      checkRisk({ ...base, fill: small, next: applyFill(null, small), openPositions: 1 }),
    ).toMatchObject({ code: "max_open_positions" });
    const sell = paperFill(order({ orderType: "sell", sizeUsd: 10 }), 50)!;
    expect(checkRisk({ ...base, fill: sell, next: null, openPositions: 5 })).toEqual({ ok: true });
  });
});

describe("heartbeat", () => {
  const snapshot = (price: number, exposure: number) => ({
    positions: [{ marketId: "market-1", side: "yes" as const, currentPrice: price }],
    markets: [{ marketId: "market-1", question: "Q", yesPrice: price, noPrice: 1 - price }],
    totalExposureUsd: exposure,
  });

  it("is material for a 0.08 move and an 11.8% exposure move", () => {
    const result = evaluateHeartbeat(snapshot(0.54, 54), snapshot(0.62, 62));
    expect(result.status).toBe("material");
    expect(result.changes.map((change) => change.type)).toEqual([
      "position_price_move",
      "watched_market_price_move",
      "watched_market_price_move",
      "exposure_move",
    ]);
    expect(result.changes[0]).toMatchObject({ previous: 0.54, current: 0.62, delta: 0.08 });
  });

  it("is a noop below thresholds and without a baseline", () => {
    expect(evaluateHeartbeat(snapshot(0.54, 54), snapshot(0.56, 56)).status).toBe("noop");
    expect(evaluateHeartbeat(null, snapshot(0.62, 62))).toEqual({ status: "noop", changes: [] });
  });
});

describe("copy trading", () => {
  it("translates a tracked BUY YES into a same-side paper order at the source notional", () => {
    expect(translateActivity(trade())).toEqual({
      ok: true,
      order: {
        marketId: "0xcondition",
        question: "Will it happen?",
        side: "yes",
        orderType: "buy",
        sizeUsd: 9.3,
        price: 0.62,
      },
    });
    expect(
      translateActivity(trade({ side: "SELL", outcome: "No", usdcSize: 4.7, price: 0.47 })),
    ).toMatchObject({ ok: true, order: { orderType: "sell", side: "no", sizeUsd: 4.7 } });
  });

  it("fails closed on unsupported or incomplete activity", () => {
    expect(translateActivity(trade({ type: "REWARD" }))).toMatchObject({
      code: "unsupported_event_type",
    });
    expect(translateActivity(trade({ conditionId: null, slug: null }))).toMatchObject({
      code: "market_id_missing",
    });
    expect(translateActivity(trade({ side: "HOLD" }))).toMatchObject({
      code: "order_type_invalid",
    });
    expect(translateActivity(trade({ outcome: "Maybe" }))).toMatchObject({
      code: "outcome_side_invalid",
    });
    expect(translateActivity(trade({ usdcSize: 0, size: 0 }))).toMatchObject({
      code: "notional_usd_invalid",
    });
  });

  it("keys events by transaction and normalizes timestamps", () => {
    expect(activityEventKey(trade())).toBe("tx:0xabc:TRADE:token-yes:BUY:1767225600");
    expect(activityEventKey(trade({ transactionHash: null }))).toBe(
      "synthetic:TRADE:0xcondition:token-yes:BUY:0:0.62:15:1767225600",
    );
    expect(activityTime(trade())).toBe("2026-01-01T00:00:00.000Z");
    expect(activityTime(trade({ timestamp: "2026-01-01T00:00:00Z" }))).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("parses the chat command", () => {
    expect(
      parseCopyCommand("start copy trading 0x1111111111111111111111111111111111111111"),
    ).toEqual({
      matched: true,
      walletAddress: "0x1111111111111111111111111111111111111111",
      valid: true,
    });
    expect(parseCopyCommand("start copy trading nope")).toMatchObject({
      matched: true,
      valid: false,
    });
    expect(parseCopyCommand("hello")).toEqual({ matched: false });
  });
});
