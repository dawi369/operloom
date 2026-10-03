export type RuntimeWebSearchRequest = {
  idempotencyKey: string;
  query: string;
  /** 1–10, default 5. */
  maxResults?: number;
  /** ISO timestamps. With `publishedBefore`, undated results are dropped too. */
  publishedAfter?: string;
  publishedBefore?: string;
};
export type RuntimeWebSearchResult = {
  /** Stable within one response; cite results by this id. */
  id: string;
  url: string;
  title: string;
  publishedAt?: string;
  excerpt: string;
};
export type RuntimeWebSearchResponse = {
  reservationId: string;
  provider: string;
  results: RuntimeWebSearchResult[];
  source: "provider" | "fixture";
};
export type RuntimeSearchPort = {
  web(input: RuntimeWebSearchRequest): Promise<RuntimeWebSearchResponse>;
};
