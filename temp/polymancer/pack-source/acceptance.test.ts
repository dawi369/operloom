import { afterEach, describe, expect, it, vi } from "vitest";

import { createPackTestRuntime } from "../../cloudflare/control-plane/src/pack-test-runtime";

const wallet = "0x1111111111111111111111111111111111111111";
const runtimes: ReturnType<typeof createPackTestRuntime>[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
const copyPortfolio = async (runtime: ReturnType<typeof start>, user?: string) =>
  (
    (await runtime.runQuery("polymancer.operator-state", {}, user)).body.output as {
      portfolio: Portfolio;
    }
  ).portfolio;

describe("polymancer acceptance", () => {
  it("copies a wallet trade into a paper position under the loss cap and replays safely", async () => {
    const runtime = start();
    const saved = await runtime.updateSettings({ maxLossCapUsd: 50 });
    expect(saved.body).toMatchObject({ version: 1, values: { maxLossCapUsd: 50 } });

    const started = await runtime.runWorkflow("polymancer.copy.start", { walletAddress: wallet });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body.report).toMatchObject({
      address: wallet,
      status: "active",
      monitors: [
        { id: "wallet-activity", status: "enabled" },
        { id: "heartbeat", status: "enabled" },
      ],
    });
    expect(
      runtime.db
        .prepare(
          "SELECT pack_trigger_id, kind, status FROM control_triggers ORDER BY pack_trigger_id",
        )
        .all(),
    ).toEqual([
      { pack_trigger_id: "heartbeat", kind: "monitor", status: "enabled" },
      { pack_trigger_id: "wallet-activity", kind: "monitor", status: "enabled" },
    ]);

    const activity = [
      trade(2),
      trade(-3600, { transactionHash: "0xold" }),
      trade(3, { type: "REWARD" }),
    ];
    const synced = await runtime.runWorkflow("polymancer.copy.sync", { activity });
    expect(synced.status, JSON.stringify(synced.body)).toBe(201);
    expect(synced.body.report).toMatchObject({ copied: 1, skipped: 1, duplicates: 0 });

    const portfolio = await copyPortfolio(runtime);
    expect(portfolio).toMatchObject({ cashUsd: 990.7, exposureUsd: 9.3 });
    expect(portfolio.positions).toMatchObject([
      { marketId: "0xcondition", side: "yes", shares: 15, avgEntryPrice: 0.62, currentPrice: 0.62 },
    ]);
    expect(portfolio.trackedWallets).toMatchObject([{ address: wallet, status: "active" }]);

    const replay = await runtime.runWorkflow("polymancer.copy.sync", { activity });
    expect(replay.body.report).toMatchObject({ copied: 0, duplicates: 2 });
    expect(await copyPortfolio(runtime)).toMatchObject({
      cashUsd: 990.7,
    });
    expect(runtime.entries("effect")).toHaveLength(1);
    expect(runtime.entries("effect")[0]).toMatchObject({ orderType: "buy", shares: 15, wallet });
    expect(runtime.entries("decision")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: "copied", settingsVersion: 1 }),
        expect.objectContaining({ outcome: "skipped", code: "unsupported_event_type" }),
      ]),
    );
    expect(runtime.entries("decision")).toHaveLength(3);
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
      "copied",
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
    const bob = await copyPortfolio(runtime, "bob");
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

  it("marks held positions from live Polymarket quotes on a monitor tick", async () => {
    const runtime = start();
    await runtime.runWorkflow("polymancer.copy.start", { walletAddress: wallet });
    await runtime.runWorkflow("polymancer.copy.sync", { activity: [trade(2)] });
    await runtime.runWorkflow("polymancer.heartbeat", { markets: [quote(0.62)] });
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      requested.push(url);
      return Response.json([
        {
          conditionId: "0xcondition",
          question: "Will it happen?",
          outcomes: '["Yes", "No"]',
          outcomePrices: '["0.71", "0.29"]',
        },
      ]);
    });

    const tick = await runtime.runWorkflow("polymancer.heartbeat", {});

    expect(tick.status, JSON.stringify(tick.body)).toBe(201);
    expect(tick.body.report).toMatchObject({ status: "material" });
    expect(requested).toEqual([
      "https://gamma-api.polymarket.com/markets?condition_ids=0xcondition",
    ]);
    const portfolio = await copyPortfolio(runtime);
    expect(portfolio.positions[0]).toMatchObject({ currentPrice: 0.71 });
  });
});

const day = 86_400_000;
const deadline = new Date(Date.now() + 90 * day).toISOString();
const shifted = (ms: number) => new Date(Date.parse(deadline) + ms).toISOString();
type Report = {
  questionId: string;
  stage: string;
  question: { forecasts: { probability: number; kind: string }[]; ideaId: string };
  matches: { venue: string; contractId: string; level: string; fit: Record<string, unknown> }[];
  venueErrors?: unknown[];
};
const report = (response: { body: { report?: unknown } }) => response.body.report as Report;

/** Recorded venue responses: an exact and a close Polymarket market, a sports event, and a close Kalshi market. */
const defaultBooks = () => ({
  "tok-exact-yes": {
    bids: [
      { price: "0.40", size: "50" },
      { price: "0.43", size: "100" },
    ],
    asks: [
      { price: "0.50", size: "20" },
      { price: "0.45", size: "100" },
    ],
  },
  "tok-exact-no": {
    bids: [
      { price: "0.50", size: "50" },
      { price: "0.53", size: "100" },
    ],
    asks: [
      { price: "0.60", size: "50" },
      { price: "0.56", size: "100" },
    ],
  },
});
const stubVenues = (
  books: Record<string, unknown> = defaultBooks(),
  markets: Record<string, unknown>[] = [],
) => {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (input: string) => {
    requested.push(input);
    const url = new URL(input);
    if (url.host === "gamma-api.polymarket.com" && url.pathname === "/markets")
      return Response.json(
        markets.filter((market) =>
          url.searchParams.getAll("condition_ids").includes(String(market.conditionId)),
        ),
      );
    if (url.host === "clob.polymarket.com" && url.pathname === "/book")
      return Response.json(books[url.searchParams.get("token_id")!] ?? { bids: [], asks: [] });
    if (url.pathname === "/public-search")
      return Response.json({
        events: [
          {
            slug: "fed-cut-by-deadline",
            tags: [{ slug: "economy", label: "Economy" }],
            markets: [
              {
                conditionId: "0xexact",
                question: "Will the Fed cut rates before the deadline?",
                description: "Resolves Yes if the FOMC lowers the federal funds target range.",
                resolutionSource: "https://www.federalreserve.gov",
                endDate: shifted(3_600_000),
                outcomes: '["Yes", "No"]',
                clobTokenIds: '["tok-exact-yes", "tok-exact-no"]',
              },
              {
                conditionId: "0xlater",
                question: "Will the Fed cut rates this year?",
                description: "Resolves Yes if the FOMC lowers the target range this year.",
                endDate: shifted(60 * day),
                outcomes: '["Yes", "No"]',
              },
            ],
          },
          {
            slug: "fed-cup",
            tags: [{ slug: "sports", label: "Sports" }],
            markets: [
              { conditionId: "0xsports", question: "Fed Cup winner?", outcomes: '["Yes","No"]' },
            ],
          },
        ],
      });
    if (url.pathname === "/v1/search/series")
      return Response.json({
        current_page: [
          { series_ticker: "KXFEDCUT", category: "Economics" },
          { series_ticker: "KXFEDCUP", category: "Sports" },
        ],
      });
    if (
      url.pathname === "/trade-api/v2/events" &&
      url.searchParams.get("series_ticker") === "KXFEDCUT"
    )
      return Response.json({
        events: [
          {
            event_ticker: "KXFEDCUT-27",
            series_ticker: "KXFEDCUT",
            title: "Fed rate cut",
            category: "Economics",
            markets: [
              {
                ticker: "KXFEDCUT-27-Y",
                title: "Will the Fed cut rates before the next quarter?",
                rules_primary: "If the Fed cuts before the date, the market resolves to Yes.",
                close_time: shifted(-20 * day),
                status: "active",
              },
            ],
          },
        ],
      });
    throw new Error(`unexpected request ${input}`);
  });
  return requested;
};
const saveInput = (input: Record<string, unknown> = {}) => ({
  idea: "The Fed blinks before the year is out.",
  text: "Will the Fed cut its policy rate before the deadline?",
  criteria: { source: "Federal Reserve FOMC statements" },
  deadline,
  topic: "economy",
  searchTerms: ["fed rate cut"],
  ...input,
});

describe("polymancer question loop", () => {
  it("turns an idea into a forecasted Question with exact and close matches, replay-safe", async () => {
    const runtime = start();
    const requested = stubVenues();

    const saved = await runtime.runWorkflow("polymancer.question.save", saveInput());
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const id = report(saved).questionId;
    expect(id).toMatch(/^q-[0-9a-f]{12}$/);
    expect(report(saved)).toMatchObject({ stage: "draft", question: { forecasts: [] } });
    expect(saved.body.artifact).toMatchObject({ kind: "polymancer.question" });

    const early = await runtime.runWorkflow("polymancer.match.find", { questionId: id });
    expect(early.body).toMatchObject({ code: "forecast_required" });
    expect(requested).toEqual([]);

    const committed = await runtime.runWorkflow("polymancer.forecast.commit", {
      questionId: id,
      probability: 0.4,
      reasonFor: "Inflation is cooling.",
      reasonAgainst: "Unemployment is still low.",
    });
    expect(report(committed)).toMatchObject({
      stage: "forecast",
      question: { forecasts: [{ probability: 0.4, kind: "original" }] },
    });

    const found = await runtime.runWorkflow("polymancer.match.find", { questionId: id });
    expect(found.status, JSON.stringify(found.body)).toBe(201);
    expect(report(found).stage).toBe("matched");
    expect(
      report(found).matches.map(({ venue, contractId, level }) => ({ venue, contractId, level })),
    ).toEqual([
      { venue: "polymarket", contractId: "0xexact", level: "exact" },
      { venue: "kalshi", contractId: "KXFEDCUT-27-Y", level: "close" },
      { venue: "polymarket", contractId: "0xlater", level: "close" },
    ]);
    expect(report(found).matches[1]!.fit.deadline).toMatchObject({ status: "differs" });
    expect(JSON.stringify(report(found))).not.toMatch(/0xsports|price/i);
    expect(requested.some((url) => url.includes("KXFEDCUP"))).toBe(false);

    const again = await runtime.runWorkflow("polymancer.match.find", { questionId: id });
    expect(report(again).matches).toHaveLength(3);
    const detail = (await runtime.runQuery("polymancer.question", { questionId: id })).body
      .output as { matches: unknown[]; idea: { text: string } };
    expect(detail.matches).toHaveLength(3);
    expect(detail.idea.text).toBe("The Fed blinks before the year is out.");

    const revised = await runtime.runWorkflow("polymancer.forecast.commit", {
      questionId: id,
      probability: 0.55,
      reason: "A soft jobs report.",
    });
    expect(report(revised).question.forecasts.map((item) => [item.probability, item.kind])).toEqual(
      [
        [0.4, "original"],
        [0.55, "revision"],
      ],
    );
    const edit = await runtime.runWorkflow(
      "polymancer.question.save",
      saveInput({ questionId: id }),
    );
    expect(edit.body).toMatchObject({ code: "question_committed" });

    const list = (await runtime.runQuery("polymancer.questions")).body.output as {
      questions: Record<string, unknown>[];
    };
    expect(list.questions).toMatchObject([
      { id, stage: "matched", forecast: 0.55, originalForecast: 0.4, bestMatch: "exact" },
    ]);
    expect(runtime.entries("decision").map((entry) => entry.outcome)).toEqual([
      "question_saved",
      "forecast_committed",
      "match_search",
      "match_search",
      "forecast_committed",
    ]);
  });

  it("forecasts a close contract's own version as a child Question", async () => {
    const runtime = start();
    stubVenues();
    const id = report(
      await runtime.runWorkflow("polymancer.question.save", saveInput()),
    ).questionId;
    await runtime.runWorkflow("polymancer.forecast.commit", { questionId: id, probability: 0.4 });
    await runtime.runWorkflow("polymancer.match.find", { questionId: id });

    const exact = await runtime.runWorkflow("polymancer.question.adopt", {
      questionId: id,
      venue: "polymarket",
      contractId: "0xexact",
    });
    expect(exact.body).toMatchObject({ code: "match_not_close" });

    const adopted = await runtime.runWorkflow("polymancer.question.adopt", {
      questionId: id,
      venue: "kalshi",
      contractId: "KXFEDCUT-27-Y",
    });
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(201);
    const child = report(adopted);
    expect(child).toMatchObject({
      stage: "draft",
      question: {
        parentQuestionId: id,
        text: "Will the Fed cut rates before the next quarter?",
        deadline: shifted(-20 * day),
        forecasts: [],
      },
      matches: [{ venue: "kalshi", contractId: "KXFEDCUT-27-Y", level: "exact" }],
    });
    const repeat = await runtime.runWorkflow("polymancer.question.adopt", {
      questionId: id,
      venue: "kalshi",
      contractId: "KXFEDCUT-27-Y",
    });
    expect(report(repeat).questionId).toBe(child.questionId);
    const list = (await runtime.runQuery("polymancer.questions")).body.output as {
      questions: { id: string }[];
    };
    expect(list.questions.map((question) => question.id).sort()).toEqual(
      [id, child.questionId].sort(),
    );
  });

  it("limits active Questions per idea, archives them and keeps users isolated", async () => {
    const runtime = start();
    const first = report(await runtime.runWorkflow("polymancer.question.save", saveInput()));
    for (const text of ["Second question?", "Third question?"])
      await runtime.runWorkflow(
        "polymancer.question.save",
        saveInput({ idea: undefined, ideaId: first.question.ideaId, text }),
      );
    const fourth = saveInput({ idea: undefined, ideaId: first.question.ideaId, text: "Fourth?" });
    expect((await runtime.runWorkflow("polymancer.question.save", fourth)).body).toMatchObject({
      code: "idea_question_limit",
    });
    const archived = await runtime.runWorkflow("polymancer.question.archive", {
      questionId: first.questionId,
    });
    expect(report(archived).stage).toBe("archived");
    expect((await runtime.runWorkflow("polymancer.question.save", fourth)).status).toBe(201);
    expect(
      (
        await runtime.runWorkflow("polymancer.forecast.commit", {
          questionId: first.questionId,
          probability: 0.5,
        })
      ).body,
    ).toMatchObject({ code: "question_closed" });

    const bob = (await runtime.runQuery("polymancer.questions", {}, "bob")).body.output;
    expect(bob).toEqual({ questions: [] });
    expect(
      (
        await runtime.runWorkflow(
          "polymancer.forecast.commit",
          { questionId: first.questionId, probability: 0.5 },
          { user: "bob" },
        )
      ).body,
    ).toMatchObject({ code: "question_not_found" });
  });

  it("rejects deadlines without a time zone and fails clearly when both venues are down", async () => {
    const runtime = start();
    const naive = await runtime.runWorkflow(
      "polymancer.question.save",
      saveInput({ deadline: "2031-01-01T00:00:00" }),
    );
    expect(naive.status).toBeGreaterThanOrEqual(400);
    const id = report(
      await runtime.runWorkflow("polymancer.question.save", saveInput()),
    ).questionId;
    await runtime.runWorkflow("polymancer.forecast.commit", { questionId: id, probability: 0.4 });
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const down = await runtime.runWorkflow("polymancer.match.find", { questionId: id });
    expect(down.body).toMatchObject({ code: "venues_unavailable" });
    const detail = (await runtime.runQuery("polymancer.question", { questionId: id })).body
      .output as { question: { stage: string } };
    expect(detail.question.stage).toBe("forecast");
  });
});

type PaperReport = Report & {
  brief?: { version: number; status: string; sourceCutoff: string; searches: string[] };
  priceCheck?: {
    verdict: { code: string };
    yes?: { shares: number; execPrice: number };
    no?: { shares: number; execPrice: number };
    gaps: { yourForecast: { yes?: number; no?: number } };
    marketMid?: number;
  };
  position?: { side: string; shares: number; maxLoss: number; status: string };
  status?: string;
  code?: string;
};
const paper = (response: { body: { report?: unknown } }) => response.body.report as PaperReport;
/** A Question with a committed forecast and an exact Polymarket match. */
const matched = async (runtime: ReturnType<typeof start>) => {
  const id = report(await runtime.runWorkflow("polymancer.question.save", saveInput())).questionId;
  await runtime.runWorkflow("polymancer.forecast.commit", {
    questionId: id,
    probability: 0.4,
    reasonFor: "Inflation is cooling.",
  });
  await runtime.runWorkflow("polymancer.match.find", { questionId: id });
  return id;
};

describe("polymancer research and paper positions", () => {
  it("briefs, prices from the book and records a paper position, replay-safe", async () => {
    const runtime = start();
    stubVenues();
    const id = await matched(runtime);

    const briefed = await runtime.runWorkflow("polymancer.brief.create", { questionId: id });
    expect(briefed.status, JSON.stringify(briefed.body)).toBe(201);
    const brief = paper(briefed).brief!;
    expect(brief).toMatchObject({ version: 1, status: "complete" });
    expect(brief.searches).toHaveLength(3);
    expect(brief.sourceCutoff).toEqual(expect.any(String));
    expect(paper(briefed).stage).toBe("matched");

    const checked = await runtime.runWorkflow("polymancer.price.check", { questionId: id });
    expect(checked.status, JSON.stringify(checked.body)).toBe(201);
    expect(paper(checked).priceCheck).toMatchObject({
      verdict: { code: "not_enough_evidence" },
      yes: { shares: 55, execPrice: 0.45 },
      no: { shares: 44, execPrice: 0.56 },
      gaps: { yourForecast: { yes: -0.05, no: 0.04 } },
      marketMid: 0.44,
    });

    const opened = await runtime.runWorkflow("polymancer.position.open", {
      questionId: id,
      side: "no",
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(paper(opened)).toMatchObject({
      stage: "positioned",
      position: { side: "no", shares: 44, maxLoss: 24.64, status: "open" },
      outcomes: { ifYes: -24.64, ifNo: 19.36 },
    });
    expect(
      (await runtime.runWorkflow("polymancer.position.open", { questionId: id, side: "no" })).body,
    ).toMatchObject({ code: "position_exists" });
    const portfolio = (await runtime.runQuery("polymancer.portfolio")).body.output as {
      paperCash: number;
      exposure: number;
      positions: { venue: string; side: string; mark: number; question: string }[];
    };
    expect(portfolio).toMatchObject({ paperCash: 975.36, exposure: 23.98 });
    expect(portfolio.positions).toMatchObject([
      { venue: "polymarket", side: "no", mark: 0.545, question: saveInput().text },
    ]);

    const closedOut = await runtime.runWorkflow("polymancer.position.close", {
      questionId: id,
      reason: "Changed my mind.",
    });
    expect(closedOut.status, JSON.stringify(closedOut.body)).toBe(201);
    expect(paper(closedOut)).toMatchObject({ stage: "watching", realizedPnl: -1.32 });
    expect((await runtime.runQuery("polymancer.portfolio")).body.output).toMatchObject({
      paperCash: 998.68,
      realizedPnl: -1.32,
      positions: [],
    });
    expect(runtime.entries("effect").map((entry) => entry.kind)).toEqual([
      "paper_buy",
      "paper_sell",
    ]);
    expect(runtime.entries("decision").map((entry) => entry.outcome)).toEqual(
      expect.arrayContaining([
        "brief_created",
        "price_check",
        "position_opened",
        "position_closed",
      ]),
    );
  });

  it("skips positions on thin books or moved prices and refuses stale or missing checks", async () => {
    const runtime = start();
    const books = defaultBooks();
    stubVenues(books);
    const id = await matched(runtime);
    expect(
      (await runtime.runWorkflow("polymancer.position.open", { questionId: id, side: "yes" })).body,
    ).toMatchObject({ code: "price_check_required" });
    expect(
      (await runtime.runWorkflow("polymancer.price.check", { questionId: id, maxLossUsd: 500 }))
        .body,
    ).toMatchObject({ code: "max_loss_above_cap" });
    await runtime.runWorkflow("polymancer.price.check", { questionId: id });

    books["tok-exact-yes"] = { bids: [], asks: [{ price: "0.49", size: "100" }] };
    const moved = await runtime.runWorkflow("polymancer.position.open", {
      questionId: id,
      side: "yes",
    });
    expect(paper(moved)).toMatchObject({ status: "skipped", code: "slippage_exceeded" });

    books["tok-exact-yes"] = { bids: [], asks: [] };
    const thin = await runtime.runWorkflow("polymancer.position.open", {
      questionId: id,
      side: "yes",
    });
    expect(paper(thin)).toMatchObject({ status: "skipped", code: "insufficient_depth" });
    expect(runtime.entries("effect")).toHaveLength(0);
    expect(
      runtime
        .entries("decision")
        .filter((entry) => entry.outcome === "skipped")
        .map((entry) => entry.code),
    ).toEqual(["slippage_exceeded", "insufficient_depth"]);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect(
      (await runtime.runWorkflow("polymancer.position.open", { questionId: id, side: "yes" })).body,
    ).toMatchObject({ code: "price_check_stale" });
  });

  it("prices only exact matches after a forecast and keeps paper inside simulation", async () => {
    const runtime = start();
    stubVenues();
    const draft = report(await runtime.runWorkflow("polymancer.question.save", saveInput()));
    expect(
      (await runtime.runWorkflow("polymancer.price.check", { questionId: draft.questionId })).body,
    ).toMatchObject({ code: "forecast_required" });
    expect(
      (await runtime.runWorkflow("polymancer.brief.create", { questionId: draft.questionId })).body,
    ).toMatchObject({ code: "forecast_required" });

    const live = start("external");
    const id = await matched(live);
    await live.runWorkflow("polymancer.price.check", { questionId: id });
    const refused = await live.runWorkflow("polymancer.position.open", {
      questionId: id,
      side: "yes",
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toContain("live_trading_unavailable");
    expect(live.entries("effect")).toHaveLength(0);
  });
});

const fedRules = "Resolves Yes if the FOMC lowers the federal funds target range.";
const gammaMarket = (input: Record<string, unknown> = {}) => ({
  conditionId: "0xexact",
  closed: false,
  outcomePrices: '["0.45", "0.55"]',
  description: fedRules,
  ...input,
});
type Tick = {
  watched: number;
  alerts: number;
  settled: number;
  proposed: number;
  skipped: number;
  researched: number;
};
const tick = async (runtime: ReturnType<typeof start>, user?: string) => {
  const response = await runtime.runWorkflow("polymancer.watch.tick", {}, { user });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.report as Tick;
};

describe("polymancer watch, outcomes and Record", () => {
  it("watches a paper position, skips research over budget, settles once and scores the Record", async () => {
    const runtime = start();
    const markets = [gammaMarket()];
    stubVenues(defaultBooks(), markets);
    await runtime.updateSettings({ researchRunsPerDay: 0 });
    const id = await matched(runtime);
    await runtime.runWorkflow("polymancer.brief.create", { questionId: id });
    await runtime.runWorkflow("polymancer.price.check", { questionId: id });
    await runtime.runWorkflow("polymancer.position.open", { questionId: id, side: "yes" });
    await runtime.runWorkflow("polymancer.question.watch", { questionId: id });
    expect(
      runtime.db.prepare("SELECT pack_trigger_id, status FROM control_triggers").all(),
    ).toEqual([{ pack_trigger_id: "watch", status: "enabled" }]);

    expect(await tick(runtime)).toMatchObject({ watched: 1, alerts: 0 });
    const quiet = await tick(runtime);
    expect(quiet).toMatchObject({ alerts: 0, skipped: 0 });

    markets[0] = gammaMarket({ outcomePrices: '["0.60", "0.40"]' });
    expect(await tick(runtime)).toMatchObject({ alerts: 1, skipped: 1, researched: 0 });
    expect(
      runtime.entries("decision").filter((entry) => entry.kind === "research_skipped"),
    ).toMatchObject([{ code: "research_budget_exhausted" }]);
    expect(
      (
        (await runtime.runQuery("polymancer.portfolio")).body.output as {
          positions: { mark: number }[];
        }
      ).positions[0],
    ).toMatchObject({ mark: 0.6 });

    markets[0] = gammaMarket({
      closed: true,
      outcomePrices: '["1", "0"]',
      umaResolutionStatus: "resolved",
    });
    expect(await tick(runtime)).toMatchObject({ settled: 1, proposed: 1 });
    expect(await tick(runtime)).toMatchObject({ settled: 0, proposed: 0, alerts: 0 });
    expect(runtime.entries("effect").map((entry) => entry.kind)).toEqual([
      "paper_buy",
      "paper_settlement",
    ]);
    expect((await runtime.runQuery("polymancer.portfolio")).body.output).toMatchObject({
      paperCash: 1030.25,
      realizedPnl: 30.25,
      positions: [],
    });
    const detail = (await runtime.runQuery("polymancer.question", { questionId: id })).body
      .output as {
      question: { stage: string; outcome: { proposed: { value: string; source: string } } };
    };
    expect(detail.question).toMatchObject({
      stage: "awaiting_outcome",
      outcome: { proposed: { value: "yes", source: "contract" } },
    });

    const confirmed = await runtime.runWorkflow("polymancer.outcome.confirm", {
      questionId: id,
      value: "yes",
    });
    expect(paper(confirmed).stage).toBe("resolved");
    const record = (await runtime.runQuery("polymancer.record")).body.output;
    expect(record).toMatchObject({
      resolved: 1,
      scores: {
        yours: { count: 1, meanBrier: 0.36, hitRate: 0 },
        polymancer: { count: 1, meanBrier: 0.9801 },
        market: { count: 1, meanBrier: 0.3136 },
      },
      calibration: { availableAfter: 20, resolved: 1 },
      paper: { realizedPnl: 30.25, openPositions: 0 },
      questions: [{ id, outcome: "yes", yours: 0.4, market: 0.44 }],
    });
    expect((await runtime.runQuery("polymancer.record", {}, "bob")).body.output).toMatchObject({
      resolved: 0,
      empty: "Your record starts when your first question resolves.",
    });
    expect(await tick(runtime, "bob")).toMatchObject({ watched: 0 });
  });

  it("re-researches a material move within budget and suggests whether the view holds", async () => {
    const runtime = start();
    const markets = [gammaMarket()];
    stubVenues(defaultBooks(), markets);
    const id = await matched(runtime);
    await runtime.runWorkflow("polymancer.brief.create", { questionId: id });
    const watched = await runtime.runWorkflow("polymancer.question.watch", { questionId: id });
    expect(paper(watched).stage).toBe("watching");
    await tick(runtime);
    markets[0] = gammaMarket({ outcomePrices: '["0.70", "0.30"]' });
    expect(await tick(runtime)).toMatchObject({ alerts: 1, researched: 1 });
    expect(runtime.entries("decision").find((entry) => entry.kind === "re_research")).toMatchObject(
      { suggestion: "keep", holds: true },
    );
    const detail = (await runtime.runQuery("polymancer.question", { questionId: id })).body
      .output as { question: { watch: { lastResearchAt?: string; baselinePrice: number } } };
    expect(detail.question.watch).toMatchObject({ baselinePrice: 0.7 });
    expect(detail.question.watch.lastResearchAt).toEqual(expect.any(String));
    markets[0] = gammaMarket({ outcomePrices: '["0.40", "0.60"]' });
    expect(await tick(runtime)).toMatchObject({ alerts: 0, researched: 0 });
  });

  it("proposes an outcome from research after the deadline and expires one left unconfirmed", async () => {
    const runtime = start();
    stubVenues();
    const id = report(
      await runtime.runWorkflow("polymancer.question.save", saveInput()),
    ).questionId;
    await runtime.runWorkflow("polymancer.forecast.commit", { questionId: id, probability: 0.7 });
    expect(
      (await runtime.runWorkflow("polymancer.outcome.confirm", { questionId: id, value: "no" }))
        .body,
    ).toMatchObject({ code: "outcome_too_early" });
    await runtime.runWorkflow("polymancer.question.watch", { questionId: id });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(deadline) + day);
    expect(await tick(runtime)).toMatchObject({ proposed: 1 });
    const proposed = (await runtime.runQuery("polymancer.question", { questionId: id })).body
      .output as { question: { stage: string; outcome: { proposed: { source: string } } } };
    expect(proposed.question).toMatchObject({
      stage: "awaiting_outcome",
      outcome: { proposed: { source: "research" } },
    });

    vi.setSystemTime(Date.parse(deadline) + 16 * day);
    await tick(runtime);
    const record = (await runtime.runQuery("polymancer.record")).body.output;
    expect(record).toMatchObject({ resolved: 0, unresolvable: 1 });
  });
});
