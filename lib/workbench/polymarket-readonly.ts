export const polymarketMarketSearchToolName = "polymarket.market.search";
export const polymarketMarketSnapshotToolName = "polymarket.market.snapshot";
export const polymarketOrderbookSnapshotToolName = "polymarket.orderbook.snapshot";
export const polymarketReadonlyPolicy = "polymarket-readonly-v0";
export const polymarketReadonlyAdapterVersion = "polymarket-readonly-v1";

export const polymarketReadonlyToolNames = [
  polymarketMarketSearchToolName,
  polymarketMarketSnapshotToolName,
  polymarketOrderbookSnapshotToolName,
] as const;

export type PolymarketReadonlyToolName = (typeof polymarketReadonlyToolNames)[number];

export type PolymarketReadonlyError = {
  code: "invalid_input" | "provider_request_failed" | "provider_response_invalid";
  message: string;
  retryable: boolean;
  redacted: true;
};

export type PolymarketMarketSearchInput = {
  query?: string;
  slug?: string;
  tagId?: string;
  limit: number;
};

export type PolymarketMarketSnapshotInput =
  | {
      marketId: string;
      slug?: never;
    }
  | {
      slug: string;
      marketId?: never;
    };

export type PolymarketOrderbookSnapshotInput = {
  tokenId: string;
};

type MarketSummary = {
  id?: string;
  slug?: string;
  question?: string;
  active?: boolean;
  closed?: boolean;
  endDate?: string;
  volume?: string;
  liquidity?: string;
  outcomes: string[];
  outcomePrices: string[];
  clobTokenIds: string[];
};

export type PolymarketMarketSearchOutput = {
  status: "ok";
  summary: string;
  source: "gamma";
  markets: MarketSummary[];
  timingMs: number;
};

export type PolymarketMarketSnapshotOutput = {
  status: "ok";
  summary: string;
  source: "gamma";
  market: MarketSummary;
  timingMs: number;
};

export type PolymarketOrderbookSnapshotOutput = {
  status: "ok";
  summary: string;
  source: "clob";
  tokenId: string;
  market?: string;
  assetId?: string;
  bestBid?: string;
  bestAsk?: string;
  spread?: string;
  lastTradePrice?: string;
  tickSize?: string;
  minOrderSize?: string;
  bidCount: number;
  askCount: number;
  topBids: Array<{ price: string; size: string }>;
  topAsks: Array<{ price: string; size: string }>;
  timingMs: number;
};

export type PolymarketReadonlyOutput =
  | PolymarketMarketSearchOutput
  | PolymarketMarketSnapshotOutput
  | PolymarketOrderbookSnapshotOutput;

export type PolymarketReadonlyResult =
  | { ok: true; output: PolymarketReadonlyOutput }
  | { ok: false; error: PolymarketReadonlyError };

export type PolymarketMarketSearchResult =
  | { ok: true; output: PolymarketMarketSearchOutput }
  | { ok: false; error: PolymarketReadonlyError };

export type PolymarketMarketSnapshotResult =
  | { ok: true; output: PolymarketMarketSnapshotOutput }
  | { ok: false; error: PolymarketReadonlyError };

export type PolymarketOrderbookSnapshotResult =
  | { ok: true; output: PolymarketOrderbookSnapshotOutput }
  | { ok: false; error: PolymarketReadonlyError };

const gammaBaseUrl = "https://gamma-api.polymarket.com";
const clobBaseUrl = "https://clob.polymarket.com";
const maxProviderResponseBytes = 512 * 1024;
const providerTimeoutMs = 8_000;

const supportedInputKeys = {
  [polymarketMarketSearchToolName]: new Set(["query", "slug", "tagId", "limit"]),
  [polymarketMarketSnapshotToolName]: new Set(["marketId", "slug"]),
  [polymarketOrderbookSnapshotToolName]: new Set(["tokenId"]),
};

const forbiddenInputKeys = new Set([
  "url",
  "endpoint",
  "host",
  "headers",
  "authorization",
  "token",
  "secret",
  "password",
  "apiKey",
  "api_key",
  "privateKey",
  "wallet",
  "order",
  "side",
  "size",
  "price",
]);

export const polymarketReadonlyError = (
  code: PolymarketReadonlyError["code"],
  message: string,
  retryable = false,
): PolymarketReadonlyError => ({ code, message, retryable, redacted: true });

export const isPolymarketReadonlyToolName = (value: string): value is PolymarketReadonlyToolName =>
  polymarketReadonlyToolNames.includes(value as PolymarketReadonlyToolName);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPolymarketError = (value: unknown): value is PolymarketReadonlyError =>
  isRecord(value) && value.redacted === true && typeof value.code === "string";

const readInputRecord = (
  toolName: PolymarketReadonlyToolName,
  input: unknown,
): Record<string, unknown> | PolymarketReadonlyError => {
  if (!isRecord(input)) {
    return polymarketReadonlyError("invalid_input", `${toolName} input must be an object.`);
  }
  const supported = supportedInputKeys[toolName];
  for (const key of Object.keys(input)) {
    if (forbiddenInputKeys.has(key) || !supported.has(key)) {
      return polymarketReadonlyError("invalid_input", `${key} is not supported by ${toolName}.`);
    }
  }
  return input;
};

const boundedString = (value: unknown, field: string, maxLength: number) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return polymarketReadonlyError("invalid_input", `${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) {
    return polymarketReadonlyError(
      "invalid_input",
      `${field} must be ${maxLength} characters or less.`,
    );
  }
  return trimmed;
};

const boundedLimit = (value: unknown) => {
  if (value === undefined) return 5;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1 || value > 20) {
    return polymarketReadonlyError("invalid_input", "limit must be an integer from 1 to 20.");
  }
  return value;
};

export const validatePolymarketMarketSearchInput = (
  input: unknown,
): PolymarketMarketSearchInput | PolymarketReadonlyError => {
  const source = readInputRecord(polymarketMarketSearchToolName, input);
  if (isPolymarketError(source)) return source;
  const query = boundedString(source.query, "query", 120);
  if (isPolymarketError(query)) return query;
  const slug = boundedString(source.slug, "slug", 160);
  if (isPolymarketError(slug)) return slug;
  const tagId = boundedString(source.tagId, "tagId", 40);
  if (isPolymarketError(tagId)) return tagId;
  const limit = boundedLimit(source.limit);
  if (isPolymarketError(limit)) return limit;
  if (!query && !slug && !tagId) {
    return polymarketReadonlyError(
      "invalid_input",
      "Provide query, slug, or tagId for bounded market search.",
    );
  }
  return { query, slug, tagId, limit };
};

export const validatePolymarketMarketSnapshotInput = (
  input: unknown,
): PolymarketMarketSnapshotInput | PolymarketReadonlyError => {
  const source = readInputRecord(polymarketMarketSnapshotToolName, input);
  if (isPolymarketError(source)) return source;
  const marketId = boundedString(source.marketId, "marketId", 80);
  if (isPolymarketError(marketId)) return marketId;
  const slug = boundedString(source.slug, "slug", 160);
  if (isPolymarketError(slug)) return slug;
  if (marketId && slug) {
    return polymarketReadonlyError("invalid_input", "Provide either marketId or slug, not both.");
  }
  if (!marketId && !slug) {
    return polymarketReadonlyError("invalid_input", "marketId or slug is required.");
  }
  return marketId ? { marketId } : { slug: slug as string };
};

export const validatePolymarketOrderbookSnapshotInput = (
  input: unknown,
): PolymarketOrderbookSnapshotInput | PolymarketReadonlyError => {
  const source = readInputRecord(polymarketOrderbookSnapshotToolName, input);
  if (isPolymarketError(source)) return source;
  const tokenId = boundedString(source.tokenId, "tokenId", 120);
  if (isPolymarketError(tokenId)) return tokenId;
  if (!tokenId) return polymarketReadonlyError("invalid_input", "tokenId is required.");
  if (!/^[a-zA-Z0-9:_-]+$/.test(tokenId)) {
    return polymarketReadonlyError("invalid_input", "tokenId contains unsupported characters.");
  }
  return { tokenId };
};

const parseJsonArrayField = (value: unknown): string[] => {
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return value;
          }
        })()
      : value;
  return Array.isArray(parsed)
    ? parsed
        .map((item) => (typeof item === "string" || typeof item === "number" ? String(item) : ""))
        .filter(Boolean)
    : [];
};

const readString = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : undefined;

const readBoolean = (value: unknown) => (typeof value === "boolean" ? value : undefined);

const toMarketSummary = (value: unknown): MarketSummary | null => {
  if (!isRecord(value)) return null;
  const question =
    readString(value.question) ??
    readString(value.title) ??
    readString(value.name) ??
    readString(value.eventTitle);
  return {
    id: readString(value.id),
    slug: readString(value.slug),
    question,
    active: readBoolean(value.active),
    closed: readBoolean(value.closed),
    endDate: readString(value.endDate) ?? readString(value.end_date),
    volume: readString(value.volume) ?? readString(value.volumeNum),
    liquidity: readString(value.liquidity) ?? readString(value.liquidityNum),
    outcomes: parseJsonArrayField(value.outcomes),
    outcomePrices: parseJsonArrayField(value.outcomePrices),
    clobTokenIds: parseJsonArrayField(value.clobTokenIds),
  };
};

const marketMatchesQuery = (market: MarketSummary, query?: string) => {
  if (!query) return true;
  const normalized = query.toLowerCase();
  return [market.question, market.slug]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes(normalized));
};

const fetchProviderJson = async (url: URL): Promise<unknown | PolymarketReadonlyError> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), providerTimeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    if (text.length > maxProviderResponseBytes) {
      return polymarketReadonlyError(
        "provider_response_invalid",
        "Provider response exceeded limit.",
      );
    }
    if (!response.ok) {
      return polymarketReadonlyError(
        "provider_request_failed",
        `Provider request failed with HTTP ${response.status}.`,
        response.status >= 500,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return polymarketReadonlyError(
        "provider_response_invalid",
        "Provider response was not JSON.",
      );
    }
  } catch {
    return polymarketReadonlyError("provider_request_failed", "Provider request failed.", true);
  } finally {
    clearTimeout(timeout);
  }
};

export const runPolymarketMarketSearch = async (
  input: PolymarketMarketSearchInput,
): Promise<PolymarketMarketSearchResult> => {
  const startedAt = Date.now();
  const useSearch = Boolean(input.query && !input.slug && !input.tagId);
  const url = new URL(useSearch ? "/public-search" : "/markets", gammaBaseUrl);
  if (useSearch) {
    // https://docs.polymarket.com/api-reference/search/search-markets-events-and-profiles
    url.searchParams.set("q", input.query!);
    url.searchParams.set("events_status", "active");
    url.searchParams.set("keep_closed_markets", "0");
    url.searchParams.set("limit_per_type", String(input.limit));
    url.searchParams.set("search_profiles", "false");
    url.searchParams.set("search_tags", "false");
  } else {
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", String(input.limit));
    if (input.slug) url.searchParams.set("slug", input.slug);
    if (input.tagId) url.searchParams.set("tag_id", input.tagId);
  }

  const payload = await fetchProviderJson(url);
  if (isPolymarketError(payload)) return { ok: false, error: payload };
  const rows =
    useSearch && isRecord(payload) && Array.isArray(payload.events)
      ? payload.events.flatMap((event) =>
          isRecord(event) && Array.isArray(event.markets) ? event.markets : [],
        )
      : Array.isArray(payload)
        ? payload
        : isRecord(payload) && Array.isArray(payload.markets)
          ? payload.markets
          : [];
  const markets = rows
    .map(toMarketSummary)
    .filter((market): market is MarketSummary => market !== null)
    .filter((market) => market.active !== false && market.closed !== true)
    .filter((market) => useSearch || marketMatchesQuery(market, input.query))
    .slice(0, input.limit);
  return {
    ok: true,
    output: {
      status: "ok",
      summary: `Found ${markets.length} public Polymarket market${markets.length === 1 ? "" : "s"}.`,
      source: "gamma",
      markets,
      timingMs: Date.now() - startedAt,
    },
  };
};

export const runPolymarketMarketSnapshot = async (
  input: PolymarketMarketSnapshotInput,
): Promise<PolymarketMarketSnapshotResult> => {
  const startedAt = Date.now();
  const url = input.marketId
    ? new URL(`/markets/${encodeURIComponent(input.marketId)}`, gammaBaseUrl)
    : new URL("/markets", gammaBaseUrl);
  if (input.slug) url.searchParams.set("slug", input.slug);
  const payload = await fetchProviderJson(url);
  if (isPolymarketError(payload)) return { ok: false, error: payload };
  const candidate = Array.isArray(payload) ? payload[0] : payload;
  const market = toMarketSummary(candidate);
  if (!market) {
    return {
      ok: false,
      error: polymarketReadonlyError(
        "provider_response_invalid",
        "Provider market payload was invalid.",
      ),
    };
  }
  return {
    ok: true,
    output: {
      status: "ok",
      summary: market.question
        ? `Loaded public market: ${market.question}`
        : "Loaded public market.",
      source: "gamma",
      market,
      timingMs: Date.now() - startedAt,
    },
  };
};

const sortBookSide = (rows: Array<{ price: string; size: string }>, direction: "bid" | "ask") =>
  [...rows].sort((a, b) =>
    direction === "bid" ? Number(b.price) - Number(a.price) : Number(a.price) - Number(b.price),
  );

const toBookRows = (value: unknown) =>
  Array.isArray(value)
    ? value
        .map((item) =>
          isRecord(item)
            ? { price: readString(item.price) ?? "", size: readString(item.size) ?? "" }
            : null,
        )
        .filter(
          (item): item is { price: string; size: string } =>
            item !== null && item.price.length > 0 && item.size.length > 0,
        )
    : [];

export const runPolymarketOrderbookSnapshot = async (
  input: PolymarketOrderbookSnapshotInput,
): Promise<PolymarketOrderbookSnapshotResult> => {
  const startedAt = Date.now();
  const url = new URL("/book", clobBaseUrl);
  url.searchParams.set("token_id", input.tokenId);
  const payload = await fetchProviderJson(url);
  if (isPolymarketError(payload)) return { ok: false, error: payload };
  if (!isRecord(payload)) {
    return {
      ok: false,
      error: polymarketReadonlyError(
        "provider_response_invalid",
        "Provider order book payload was invalid.",
      ),
    };
  }

  const bids = sortBookSide(toBookRows(payload.bids), "bid");
  const asks = sortBookSide(toBookRows(payload.asks), "ask");
  const bestBid = bids[0]?.price;
  const bestAsk = asks[0]?.price;
  const spread =
    bestBid && bestAsk && Number.isFinite(Number(bestAsk) - Number(bestBid))
      ? (Number(bestAsk) - Number(bestBid)).toFixed(4)
      : undefined;
  return {
    ok: true,
    output: {
      status: "ok",
      summary: `Loaded public order book with ${bids.length} bid${bids.length === 1 ? "" : "s"} and ${
        asks.length
      } ask${asks.length === 1 ? "" : "s"}.`,
      source: "clob",
      tokenId: input.tokenId,
      market: readString(payload.market),
      assetId: readString(payload.asset_id),
      bestBid,
      bestAsk,
      spread,
      lastTradePrice: readString(payload.last_trade_price),
      tickSize: readString(payload.tick_size),
      minOrderSize: readString(payload.min_order_size),
      bidCount: bids.length,
      askCount: asks.length,
      topBids: bids.slice(0, 5),
      topAsks: asks.slice(0, 5),
      timingMs: Date.now() - startedAt,
    },
  };
};

export const runPolymarketReadonlyTool = async (
  toolName: PolymarketReadonlyToolName,
  input:
    | PolymarketMarketSearchInput
    | PolymarketMarketSnapshotInput
    | PolymarketOrderbookSnapshotInput,
): Promise<PolymarketReadonlyResult> => {
  if (toolName === polymarketMarketSearchToolName) {
    return runPolymarketMarketSearch(input as PolymarketMarketSearchInput);
  }
  if (toolName === polymarketMarketSnapshotToolName) {
    return runPolymarketMarketSnapshot(input as PolymarketMarketSnapshotInput);
  }
  return runPolymarketOrderbookSnapshot(input as PolymarketOrderbookSnapshotInput);
};
