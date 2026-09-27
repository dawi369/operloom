import { afterEach, describe, expect, it } from "vitest";

import { createPackTestRuntime } from "../../cloudflare/control-plane/src/pack-test-runtime";

const wallet = "0x1111111111111111111111111111111111111111";
const runtimes: ReturnType<typeof createPackTestRuntime>[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
});
const start = (effectTarget: "simulation" | "external" = "simulation") => {
  const runtime = createPackTestRuntime({
    packId: "polymancer",
    users: ["ann", "bob"],
    effectTarget,
  });
  runtimes.push(runtime);
  return runtime;
};
const trade = (secondsFromNow: number, input: Record<string, unknown> = {}) => ({
  proxyWallet: wallet,
  timestamp: Math.ceil(Date.now() / 1000) + secondsFromNow,
  type: "TRADE",
  size: 15,
  usdcSize: 9.3,
  transactionHash: `0xtx${secondsFromNow}`,
  price: 0.62,
  asset: "token-yes",
  side: "BUY",
  outcomeIndex: 0,
  title: "Will it happen?",
  outcome: "Yes",
  conditionId: "0xcondition",
  ...input,
});
const quote = (yesPrice: number) => ({
  marketId: "0xcondition",
  question: "Will it happen?",
  yesPrice,
  noPrice: Number((1 - yesPrice).toFixed(6)),
});
type Portfolio = {
  cashUsd: number;
  exposureUsd: number;
  positions: {
    marketId: string;
    side: string;
    shares: number;
    avgEntryPrice: number;
    currentPrice: number;
  }[];
  trackedWallets: { address: string; status: string }[];
};

describe("polymancer acceptance", () => {
  it("saves a strategy, copies a wallet trade into a paper position and replays safely", async () => {
    const runtime = start();
    const saved = await runtime.updateSettings({
      strategyPrompt: "Mirror politics whales for days; never exceed 50 USD per market.",
      maxPositionUsd: 50,
    });
    expect(saved.body).toMatchObject({ version: 1, values: { maxPositionUsd: 50 } });

    const started = await runtime.runWorkflow("polymancer.copy.start", { walletAddress: wallet });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body.report).toMatchObject({ address: wallet, status: "active" });

    const activity = [
      trade(2),
      trade(-3600, { transactionHash: "0xold" }),
      trade(3, { type: "REWARD" }),
    ];
    const synced = await runtime.runWorkflow("polymancer.copy.sync", { activity });
    expect(synced.status, JSON.stringify(synced.body)).toBe(201);
    expect(synced.body.report).toMatchObject({ copied: 1, skipped: 1, duplicates: 0 });

    const portfolio = (await runtime.runQuery("polymancer.portfolio")).body.output as Portfolio;
    expect(portfolio).toMatchObject({ cashUsd: 990.7, exposureUsd: 9.3 });
    expect(portfolio.positions).toMatchObject([
      { marketId: "0xcondition", side: "yes", shares: 15, avgEntryPrice: 0.62, currentPrice: 0.62 },
    ]);
    expect(portfolio.trackedWallets).toMatchObject([{ address: wallet, status: "active" }]);

    const replay = await runtime.runWorkflow("polymancer.copy.sync", { activity });
    expect(replay.body.report).toMatchObject({ copied: 0, duplicates: 2 });
    expect((await runtime.runQuery("polymancer.portfolio")).body.output).toMatchObject({
      cashUsd: 990.7,
    });
    expect(runtime.entries("effect")).toHaveLength(1);
    expect(runtime.entries("effect")[0]).toMatchObject({ orderType: "buy", shares: 15, wallet });
  });

  it("records heartbeat noop and material decisions and exposes activity", async () => {
    const runtime = start();
    await runtime.runWorkflow("polymancer.copy.start", { walletAddress: wallet });
    await runtime.runWorkflow("polymancer.copy.sync", { activity: [trade(2)] });

    expect(
      (await runtime.runWorkflow("polymancer.heartbeat", { markets: [quote(0.62)] })).body.report,
    ).toMatchObject({ status: "noop" });
    expect(
      (await runtime.runWorkflow("polymancer.heartbeat", { markets: [quote(0.64)] })).body.report,
    ).toMatchObject({ status: "noop" });
    const material = await runtime.runWorkflow("polymancer.heartbeat", { markets: [quote(0.7)] });
    expect(material.body.report).toMatchObject({ status: "material" });
    expect(
      (material.body.report!.changes as { type: string }[]).map((change) => change.type),
    ).toContain("position_price_move");
    expect(runtime.entries("decision").map((entry) => entry.outcome)).toEqual([
      "copy_trading_started",
      "noop",
      "noop",
      "material",
    ]);

    const state = (await runtime.runQuery("polymancer.operator-state")).body.output as {
      portfolio: Portfolio;
      activity: { status: string; fillId?: string }[];
    };
    expect(state.portfolio.positions[0]).toMatchObject({ currentPrice: 0.7 });
    expect(state.activity).toMatchObject([{ status: "copied" }]);
  });

  it("keeps users isolated and fails closed outside simulation", async () => {
    const runtime = start();
    await runtime.runWorkflow("polymancer.copy.start", { walletAddress: wallet });
    await runtime.runWorkflow("polymancer.copy.sync", { activity: [trade(2)] });
    const bob = (await runtime.runQuery("polymancer.portfolio", {}, "bob")).body
      .output as Portfolio;
    expect(bob).toMatchObject({ cashUsd: 1000, exposureUsd: 0, positions: [], trackedWallets: [] });
    expect(
      (await runtime.runWorkflow("polymancer.copy.sync", { activity: [trade(2)] }, { user: "bob" }))
        .body.report,
    ).toMatchObject({ wallets: 0, copied: 0 });

    const live = start("external");
    await live.runWorkflow("polymancer.copy.start", { walletAddress: wallet });
    const refused = await live.runWorkflow("polymancer.copy.sync", { activity: [trade(2)] });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toContain("live_trading_unavailable");
    expect(live.entries("effect")).toHaveLength(0);
  });
});
