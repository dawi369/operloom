import { describe, expect, it } from "vitest";

import {
  deadlineFit,
  isZonedDeadline,
  matchLevel,
  rankCandidates,
  searchTermsFor,
  stageAfterMatch,
  type Candidate,
  type Fit,
} from "./questions";
import { kalshiSeriesTickers, normalizeKalshiEvents, normalizePolymarketSearch } from "./venues";

const yes: Fit = { status: "matches", reason: "Same." };
const no: Fit = { status: "differs", reason: "Different." };
const candidate = (input: Partial<Candidate>): Candidate => ({
  venue: "polymarket",
  contractId: "c",
  title: "Title",
  rules: "",
  url: "https://polymarket.com",
  ...input,
});

describe("question matching rules", () => {
  it("requires an explicit time zone on deadlines", () => {
    expect(isZonedDeadline("2026-06-30T23:59:00Z")).toBe(true);
    expect(isZonedDeadline("2026-06-30T23:59:00-04:00")).toBe(true);
    expect(isZonedDeadline("2026-06-30T23:59:00")).toBe(false);
    expect(isZonedDeadline("2026-06-30")).toBe(false);
  });

  it("treats deadlines within 48 hours as the same and explains a difference", () => {
    expect(deadlineFit("2026-06-30T23:59:00Z", "2026-07-01T12:00:00Z")).toEqual({
      status: "matches",
      reason: "Both end on June 30, 2026.",
    });
    expect(deadlineFit("2026-06-30T23:59:00Z", "2026-12-31T12:00:00Z")).toEqual({
      status: "differs",
      reason: "The contract ends on December 31, 2026; your question runs to June 30, 2026.",
    });
    expect(deadlineFit("2026-06-30T23:59:00Z").status).toBe("differs");
  });

  it("assigns exact, close and related levels from the rule fit", () => {
    expect(matchLevel({ wording: yes, deadline: yes, source: yes })).toBe("exact");
    expect(matchLevel({ wording: yes, deadline: no, source: yes })).toBe("close");
    expect(matchLevel({ wording: yes, deadline: yes, source: no })).toBe("close");
    expect(matchLevel({ wording: no, deadline: yes, source: yes })).toBe("related");
  });

  it("derives search phrases when the interview recorded none", () => {
    expect(searchTermsFor({ text: "Will the Fed cut rates by 50bps before July 2026?" })).toEqual([
      "fed cut rates 50bps july",
      "fed cut rates",
    ]);
    expect(searchTermsFor({ text: "x", searchTerms: ["a", "b", "c", "d"] })).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("ranks by shared words, then the nearest deadline, without duplicates", () => {
    const question = { text: "Will the Fed cut rates in June?", deadline: "2026-06-30T00:00:00Z" };
    const ranked = rankCandidates(
      [
        candidate({ contractId: "far", title: "Fed cuts rates", deadline: "2026-12-31T00:00:00Z" }),
        candidate({
          contractId: "near",
          title: "Fed cuts rates",
          deadline: "2026-07-01T00:00:00Z",
        }),
        candidate({
          contractId: "near",
          title: "Fed cuts rates",
          deadline: "2026-07-01T00:00:00Z",
        }),
        candidate({
          contractId: "off",
          title: "Bitcoin above 100k",
          deadline: "2026-06-30T00:00:00Z",
        }),
      ],
      question,
      3,
    );
    expect(ranked.map((item) => item.contractId)).toEqual(["near", "far", "off"]);
  });

  it("moves only early-stage Questions after a search", () => {
    expect(stageAfterMatch("forecast", true)).toBe("matched");
    expect(stageAfterMatch("matched", false)).toBe("unmatched");
    expect(stageAfterMatch("watching", true)).toBe("watching");
  });
});

describe("venue normalizers", () => {
  it("keeps open binary non-sports Polymarket markets", () => {
    const candidates = normalizePolymarketSearch({
      events: [
        {
          slug: "fed-june",
          title: "Fed decision in June",
          tags: [{ label: "Economy", slug: "economy" }],
          markets: [
            {
              conditionId: "0xa",
              question: "Fed cuts in June?",
              description: "Resolves Yes if the FOMC lowers the target range.",
              resolutionSource: "federalreserve.gov",
              endDate: "2026-06-17T00:00:00Z",
              outcomes: '["Yes", "No"]',
            },
            { conditionId: "0xb", question: "Closed one", closed: true, outcomes: '["Yes","No"]' },
            { conditionId: "0xc", question: "Multi", outcomes: '["A","B","C"]' },
          ],
        },
        {
          slug: "final",
          tags: [{ label: "Sports", slug: "sports" }],
          markets: [{ conditionId: "0xd", question: "Who wins?", outcomes: '["Yes","No"]' }],
        },
      ],
    });
    expect(candidates).toEqual([
      {
        venue: "polymarket",
        contractId: "0xa",
        title: "Fed cuts in June?",
        rules: "Resolves Yes if the FOMC lowers the target range.",
        resolutionSource: "federalreserve.gov",
        deadline: "2026-06-17T00:00:00Z",
        url: "https://polymarket.com/event/fed-june",
      },
    ]);
  });

  it("keeps Kalshi series and markets outside excluded categories and combos", () => {
    expect(
      kalshiSeriesTickers({
        current_page: [
          { series_ticker: "KXFED", category: "Economics" },
          { series_ticker: "KXNBA", category: "Sports" },
          { series_ticker: "KXMVECROSS", category: "Economics" },
        ],
      }),
    ).toEqual(["KXFED"]);
    const candidates = normalizeKalshiEvents({
      events: [
        {
          event_ticker: "KXFED-26JUN",
          series_ticker: "KXFED",
          title: "Fed rate after June meeting",
          category: "Economics",
          markets: [
            {
              ticker: "KXFED-26JUN-T4.00",
              yes_sub_title: "Above 4.00%",
              rules_primary: "If the upper bound is above 4.00%, Yes.",
              rules_secondary: "Source: Federal Reserve.",
              close_time: "2026-06-17T18:00:00Z",
              status: "active",
            },
            { ticker: "KXFED-26JUN-T3.75", yes_sub_title: "Above 3.75%", status: "finalized" },
          ],
        },
      ],
    });
    expect(candidates).toEqual([
      {
        venue: "kalshi",
        contractId: "KXFED-26JUN-T4.00",
        title: "Fed rate after June meeting: Above 4.00%",
        rules: "If the upper bound is above 4.00%, Yes.\n\nSource: Federal Reserve.",
        deadline: "2026-06-17T18:00:00Z",
        url: "https://kalshi.com/markets/kxfed",
        venueData: { seriesTicker: "KXFED" },
      },
    ]);
  });
});
