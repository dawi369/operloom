import type {
  RuntimeRecord,
  RuntimeSearchPort,
  RuntimeWebSearchRequest,
  RuntimeWebSearchResponse,
  RuntimeWebSearchResult,
} from "@operloom/agent-sdk";
import {
  requireDurableAttemptAuthority,
  type DurableAttemptAuthority,
} from "./durable-attempt-authority";
import { reserveRuntimeUsage, settleRuntimeUsage } from "./runtime-usage";
import type { AgentIdentity, Env } from "./types";

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};
const excerptLimit = 1500;
const isoTime = (value: string | undefined, field: string) => {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return fail("search_request_invalid", `${field} must be ISO time`);
  return new Date(time).toISOString();
};
const bounded = (value: unknown, limit: number) =>
  typeof value === "string" ? value.trim().slice(0, limit) : "";

/** Keeps only results inside the requested publish window; a cutoff also drops undated results. */
export const withinWindow = (
  results: readonly RuntimeWebSearchResult[],
  window: { publishedAfter?: string; publishedBefore?: string },
) =>
  results.filter((result) => {
    const published = result.publishedAt ? Date.parse(result.publishedAt) : Number.NaN;
    if (window.publishedBefore && !(published <= Date.parse(window.publishedBefore))) return false;
    if (window.publishedAfter && Number.isFinite(published))
      return published >= Date.parse(window.publishedAfter);
    return true;
  });

const fixtureResults = (
  request: Required<Pick<RuntimeWebSearchRequest, "query">> & {
    maxResults: number;
    publishedBefore?: string;
  },
): RuntimeWebSearchResult[] => {
  const anchor = Date.parse(request.publishedBefore ?? "2026-01-01T00:00:00.000Z");
  return Array.from({ length: Math.min(request.maxResults, 3) }, (_, index) => ({
    id: `fixture-${index + 1}`,
    url: `https://example.com/fixture/${index + 1}?q=${encodeURIComponent(request.query)}`,
    title: `Fixture source ${index + 1} for "${request.query.slice(0, 80)}"`,
    publishedAt: new Date(anchor - (index + 1) * 7 * 86_400_000).toISOString(),
    excerpt: `Deterministic local search fixture ${index + 1}.`,
  }));
};

const searchExa = async (
  apiKey: string,
  request: { query: string; maxResults: number; publishedAfter?: string; publishedBefore?: string },
  signal: AbortSignal,
): Promise<RuntimeWebSearchResult[]> => {
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      query: request.query,
      type: "auto",
      numResults: request.maxResults,
      ...(request.publishedAfter ? { startPublishedDate: request.publishedAfter } : {}),
      ...(request.publishedBefore ? { endPublishedDate: request.publishedBefore } : {}),
      contents: { text: { maxCharacters: excerptLimit } },
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  if (!response.ok)
    return fail("search_call_failed", `Search provider returned ${response.status}`);
  const body = (await response.json()) as { results?: unknown };
  if (!Array.isArray(body.results)) return fail("search_call_failed", "Search response is invalid");
  return body.results.slice(0, request.maxResults).flatMap((item, index) => {
    const record = (item ?? {}) as Record<string, unknown>;
    const url = bounded(record.url, 2048);
    if (!/^https?:\/\//.test(url)) return [];
    const published =
      typeof record.publishedDate === "string" ? Date.parse(record.publishedDate) : NaN;
    return [
      {
        id: `r${index + 1}`,
        url,
        title: bounded(record.title, 300) || url,
        ...(Number.isFinite(published) ? { publishedAt: new Date(published).toISOString() } : {}),
        excerpt: bounded(record.text ?? record.summary, excerptLimit),
      },
    ];
  });
};

/** Dated web search for packages, metered as a tool call; the provider key never leaves the Worker. */
export const createRuntimeSearchPort = (
  env: Env,
  identity: AgentIdentity,
  input: {
    runId: string;
    packId: string;
    signal: AbortSignal;
    durableAttempt?: DurableAttemptAuthority;
  },
): RuntimeSearchPort => ({
  async web(incoming) {
    const request = structuredClone(incoming);
    input.signal.throwIfAborted();
    const query = typeof request.query === "string" ? request.query.trim() : "";
    const maxResults = request.maxResults ?? 5;
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(request.idempotencyKey) ||
      !query ||
      query.length > 512 ||
      !Number.isInteger(maxResults) ||
      maxResults < 1 ||
      maxResults > 10
    )
      return fail(
        "search_request_invalid",
        "Search needs an operation key, a query of at most 512 characters and 1–10 results",
      );
    const publishedAfter = isoTime(request.publishedAfter, "publishedAfter");
    const publishedBefore = isoTime(request.publishedBefore, "publishedBefore");
    const window = {
      ...(publishedAfter ? { publishedAfter } : {}),
      ...(publishedBefore ? { publishedBefore } : {}),
    };
    const fixture = env.OPERLOOM_E2E_MODE === "true" && env.OPERLOOM_ENVIRONMENT === "local";
    if (!fixture && !env.EXA_API_KEY)
      return fail("search_provider_unconfigured", "The search provider is not configured");
    const claim = await reserveRuntimeUsage(env, identity, {
      runId: input.runId,
      durableAttempt: input.durableAttempt,
      runKind: "workflow",
      packId: input.packId,
      kind: "tool",
      operationKey: `search-${request.idempotencyKey}`,
      payload: { query, maxResults, ...window },
      maxRuntimeMs: 20000,
    });
    if (!claim.fresh) {
      if (claim.reservation.status === "settled" && claim.reservation.result_json)
        return JSON.parse(claim.reservation.result_json) as RuntimeWebSearchResponse;
      return fail(
        claim.reservation.error_code ?? "search_outcome_unknown",
        "This search has no reusable outcome; use a new operation key",
      );
    }
    let results: RuntimeWebSearchResult[];
    try {
      results = fixture
        ? fixtureResults({ query, maxResults, publishedBefore: window.publishedBefore })
        : await searchExa(env.EXA_API_KEY!, { query, maxResults, ...window }, input.signal);
    } catch (error) {
      const errorCode = input.signal.aborted ? "search_cancelled" : "search_call_failed";
      await settleRuntimeUsage(env, claim.reservation, {
        status: "unknown",
        source: fixture ? "fixture" : "provider",
        errorCode,
      });
      return fail(errorCode, error instanceof Error ? error.message : "Search failed");
    }
    const response: RuntimeWebSearchResponse = {
      reservationId: claim.reservation.id,
      provider: fixture ? "fixture" : "exa",
      results: withinWindow(results, window),
      source: fixture ? "fixture" : "provider",
    };
    await settleRuntimeUsage(env, claim.reservation, {
      status: "settled",
      source: response.source,
      result: response as unknown as RuntimeRecord,
    });
    input.signal.throwIfAborted();
    await requireDurableAttemptAuthority(env, identity, input.runId, input.durableAttempt);
    return response;
  },
});
