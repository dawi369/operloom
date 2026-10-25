/** Public venue reads for matching and pricing: Polymarket Gamma and CLOB, and Kalshi. Normalizers are pure. */
import { marketsUrl } from "./domain";
import { rulesExcerptLength, type Candidate, type Venue, type VenueData } from "./questions";
import type { ContractStatus } from "./record";
import {
  kalshiBooks,
  kalshiTakerCoefficient,
  polymarketBook,
  type Book,
  type FeeModel,
} from "./trading";

type Json = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const list = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};
const records = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is Json => !!item && typeof item === "object")
    : [];

export const polymarketSearchUrl = (term: string) =>
  `https://gamma-api.polymarket.com/public-search?${new URLSearchParams({
    q: term,
    limit_per_type: "10",
    events_status: "active",
    keep_closed_markets: "0",
  })}`;

/** Binary, open, non-sports markets from Gamma's public search. */
export const normalizePolymarketSearch = (body: unknown): Candidate[] =>
  records((body as Json | null)?.events).flatMap((event) => {
    const sports = records(event.tags).some((tag) =>
      [tag.slug, tag.label].some((value) => text(value).toLowerCase() === "sports"),
    );
    if (sports) return [];
    return records(event.markets).flatMap((market): Candidate[] => {
      if (market.closed === true || market.active === false) return [];
      const outcomes = list(market.outcomes).map((outcome) => text(outcome).toLowerCase());
      if (outcomes.length && (outcomes.length !== 2 || outcomes[0] !== "yes")) return [];
      const contractId = text(market.conditionId) || text(market.slug) || text(market.id);
      const title = text(market.question) || text(event.title);
      if (!contractId || !title) return [];
      const slug = text(event.slug) || text(market.slug);
      const deadline = text(market.endDate) || text(event.endDate);
      const resolutionSource = text(market.resolutionSource) || text(event.resolutionSource);
      const [yes, no] = list(market.clobTokenIds).map(text);
      const schedule = (market.feeSchedule ?? null) as Json | null;
      const rate = Number(schedule?.rate);
      const venueData = {
        ...(yes && no ? { tokenIds: { yes, no } } : {}),
        ...(Number.isFinite(rate) && rate >= 0
          ? { fee: { rate, exponent: Number(schedule?.exponent ?? 1) || 1 } }
          : {}),
      };
      return [
        {
          venue: "polymarket",
          contractId,
          title,
          rules: (text(market.description) || text(event.description)).slice(0, rulesExcerptLength),
          ...(resolutionSource ? { resolutionSource } : {}),
          ...(deadline ? { deadline } : {}),
          url: slug
            ? `https://polymarket.com/event/${encodeURIComponent(slug)}`
            : "https://polymarket.com",
          ...(Object.keys(venueData).length ? { venueData } : {}),
        },
      ];
    });
  });

const kalshiBase = "https://api.elections.kalshi.com";
const kalshiExcluded = new Set(["sports", "mentions", "exotics"]);
const kalshiAllowed = (category: unknown, ticker: unknown) =>
  !kalshiExcluded.has(text(category).toLowerCase()) && !text(ticker).startsWith("KXMVE");

/** Kalshi's documented API has no text search; the site's public series search finds series tickers. */
export const kalshiSeriesSearchUrl = (term: string) =>
  `${kalshiBase}/v1/search/series?${new URLSearchParams({ query: term, page_size: "10" })}`;
export const kalshiSeriesTickers = (body: unknown, limit = 3) =>
  records((body as Json | null)?.current_page)
    .filter((series) => kalshiAllowed(series.category, series.series_ticker))
    .map((series) => text(series.series_ticker))
    .filter(Boolean)
    .slice(0, limit);

export const kalshiEventsUrl = (seriesTicker: string) =>
  `${kalshiBase}/trade-api/v2/events?${new URLSearchParams({
    series_ticker: seriesTicker,
    status: "open",
    with_nested_markets: "true",
    limit: "20",
  })}`;

export const normalizeKalshiEvents = (body: unknown): Candidate[] =>
  records((body as Json | null)?.events).flatMap((event) => {
    if (!kalshiAllowed(event.category, event.event_ticker)) return [];
    const markets = records(event.markets);
    const series = text(event.series_ticker);
    return markets.flatMap((market): Candidate[] => {
      const status = text(market.status);
      if (status && status !== "active" && status !== "open") return [];
      const contractId = text(market.ticker);
      const subtitle = text(market.yes_sub_title);
      const title =
        markets.length > 1 && subtitle && text(event.title)
          ? `${text(event.title)}: ${subtitle}`
          : text(market.title) || text(event.title);
      if (!contractId || !title) return [];
      const deadline = text(market.close_time);
      return [
        {
          venue: "kalshi",
          contractId,
          title,
          rules: [text(market.rules_primary), text(market.rules_secondary)]
            .filter(Boolean)
            .join("\n\n")
            .slice(0, rulesExcerptLength),
          ...(deadline ? { deadline } : {}),
          url: series
            ? `https://kalshi.com/markets/${encodeURIComponent(series.toLowerCase())}`
            : "https://kalshi.com",
          ...(series ? { venueData: { seriesTicker: series } } : {}),
        },
      ];
    });
  });

const getJson = async (url: string, signal: AbortSignal) => {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
  });
  if (!response.ok) throw new Error(`${new URL(url).host} returned ${response.status}`);
  return (await response.json()) as unknown;
};

const searchPolymarket = async (terms: readonly string[], signal: AbortSignal) =>
  (
    await Promise.all(
      terms
        .slice(0, 2)
        .map(async (term) =>
          normalizePolymarketSearch(await getJson(polymarketSearchUrl(term), signal)),
        ),
    )
  ).flat();

const searchKalshi = async (terms: readonly string[], signal: AbortSignal) => {
  const tickers = kalshiSeriesTickers(await getJson(kalshiSeriesSearchUrl(terms[0]!), signal));
  return (
    await Promise.all(
      tickers.map(async (ticker) =>
        normalizeKalshiEvents(await getJson(kalshiEventsUrl(ticker), signal)),
      ),
    )
  ).flat();
};

/** CLOB host the deterministic pack fixtures and the long-standing public docs use. */
export const polymarketBookUrl = (tokenId: string) =>
  `https://clob.polymarket.com/book?${new URLSearchParams({ token_id: tokenId })}`;
export const kalshiOrderbookUrl = (ticker: string) =>
  `${kalshiBase}/trade-api/v2/markets/${encodeURIComponent(ticker)}/orderbook`;
export const kalshiSeriesUrl = (ticker: string) =>
  `${kalshiBase}/trade-api/v2/series/${encodeURIComponent(ticker)}`;

/** Kalshi `quadratic` series fees; other fee types are reported as unknown rather than guessed. */
export const kalshiFeeModel = (body: unknown): FeeModel | null => {
  const series = ((body ?? {}) as { series?: Json }).series;
  const multiplier = Number(series?.fee_multiplier);
  return text(series?.fee_type).startsWith("quadratic") && Number.isFinite(multiplier)
    ? { kind: "kalshi", multiplier, coefficient: kalshiTakerCoefficient }
    : null;
};

export type Quote = { yes: Book; no: Book; fee: FeeModel; feeKnown: boolean; quotedAt: string };

const settledUma = new Set(["resolved", "settled"]);
/** Gamma market → watch status. Settled when closed with a final 1/0 (or split) price. */
export const polymarketStatus = (market: Json): ContractStatus => {
  const prices = list(market.outcomePrices).map(Number);
  const yes = prices[0];
  const price = Number.isFinite(yes) ? yes : undefined;
  const final =
    prices.length === 2 && prices.every((value) => value === 0 || value === 0.5 || value === 1);
  const rules = text(market.description).slice(0, rulesExcerptLength);
  if (market.closed === true && (settledUma.has(text(market.umaResolutionStatus)) || final))
    return { status: "settled", payout: price, ...(rules ? { rules } : {}) };
  return {
    status: market.closed === true ? "closed" : "open",
    ...(price !== undefined ? { price } : {}),
    ...(rules ? { rules } : {}),
  };
};

/** Kalshi market → watch status. `finalized` with a yes/no result is settled. */
export const kalshiStatus = (body: unknown): ContractStatus => {
  const market = ((body ?? {}) as { market?: Json }).market ?? {};
  const bid = Number(market.yes_bid_dollars);
  const ask = Number(market.yes_ask_dollars);
  const last = Number(market.last_price_dollars);
  const price =
    bid > 0 && ask > 0 ? Number(((bid + ask) / 2).toFixed(4)) : last > 0 ? last : undefined;
  const rules = [text(market.rules_primary), text(market.rules_secondary)]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, rulesExcerptLength);
  const status = text(market.status);
  const result = text(market.result);
  if ((status === "finalized" || status === "settled") && (result === "yes" || result === "no"))
    return { status: "settled", payout: result === "yes" ? 1 : 0, ...(rules ? { rules } : {}) };
  return {
    status: status === "active" || status === "open" ? "open" : "closed",
    ...(price !== undefined ? { price } : {}),
    ...(rules ? { rules } : {}),
  };
};

/** Current status of each contract, keyed by `venue:contractId`; a missing key means the read failed. */
export const fetchStatuses = async (
  contracts: readonly { venue: Venue; contractId: string }[],
  signal: AbortSignal,
) => {
  const statuses = new Map<string, ContractStatus>();
  const polymarket = [
    ...new Set(
      contracts.filter((item) => item.venue === "polymarket").map((item) => item.contractId),
    ),
  ];
  const kalshi = [
    ...new Set(contracts.filter((item) => item.venue === "kalshi").map((item) => item.contractId)),
  ];
  await Promise.allSettled([
    ...(polymarket.length
      ? [
          getJson(marketsUrl(polymarket), signal).then((body) => {
            for (const market of records(body))
              statuses.set(`polymarket:${text(market.conditionId)}`, polymarketStatus(market));
          }),
        ]
      : []),
    ...kalshi.map((ticker) =>
      getJson(`${kalshiBase}/trade-api/v2/markets/${encodeURIComponent(ticker)}`, signal).then(
        (body) => statuses.set(`kalshi:${ticker}`, kalshiStatus(body)),
      ),
    ),
  ]);
  return statuses;
};

/** Live books for both outcomes of a matched contract, plus its taker fee model. */
export const fetchQuote = async (
  match: { venue: Venue; contractId: string; venueData?: VenueData },
  signal: AbortSignal,
): Promise<Quote> => {
  const quotedAt = new Date().toISOString();
  if (match.venue === "polymarket") {
    const tokens = match.venueData?.tokenIds;
    if (!tokens) throw new Error("This Polymarket contract has no order-book tokens.");
    const [yes, no] = await Promise.all(
      [tokens.yes, tokens.no].map(async (token) =>
        polymarketBook(await getJson(polymarketBookUrl(token), signal)),
      ),
    );
    const schedule = match.venueData?.fee;
    return {
      yes: yes!,
      no: no!,
      fee: schedule ? { kind: "polymarket", ...schedule } : { kind: "none" },
      feeKnown: !!schedule,
      quotedAt,
    };
  }
  const series = match.venueData?.seriesTicker;
  const [books, fee] = await Promise.all([
    getJson(kalshiOrderbookUrl(match.contractId), signal).then(kalshiBooks),
    series ? getJson(kalshiSeriesUrl(series), signal).then(kalshiFeeModel) : Promise.resolve(null),
  ]);
  return { ...books, fee: fee ?? { kind: "none" }, feeKnown: !!fee, quotedAt };
};

/** Searches both venues; one venue failing leaves the other's candidates usable. */
export const searchVenues = async (terms: readonly string[], signal: AbortSignal) => {
  const venues: [Venue, typeof searchPolymarket][] = [
    ["polymarket", searchPolymarket],
    ["kalshi", searchKalshi],
  ];
  const settled = await Promise.allSettled(venues.map(([, search]) => search(terms, signal)));
  return {
    candidates: settled.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
    errors: settled.flatMap((result, index) =>
      result.status === "rejected"
        ? [
            {
              venue: venues[index]![0],
              message: result.reason instanceof Error ? result.reason.message : "request failed",
            },
          ]
        : [],
    ),
  };
};
