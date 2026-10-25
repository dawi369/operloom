/** Pure Question and matching logic. No I/O. */

export const topics = ["politics", "economy", "tech_ai", "science", "world"] as const;
export type Topic = (typeof topics)[number];

export const stages = [
  "draft",
  "forecast",
  "briefed",
  "matched",
  "unmatched",
  "watching",
  "positioned",
  "awaiting_outcome",
  "resolved",
  "archived",
] as const;
export type Stage = (typeof stages)[number];

export type Forecast = {
  probability: number;
  low?: number;
  high?: number;
  reasonFor?: string;
  reasonAgainst?: string;
  reason?: string;
  at: string;
  kind: "original" | "revision";
};
export type Criteria = { source: string; definitions?: string; fallback?: string };
export type OutcomeValue = "yes" | "no" | "unresolvable";
export type Outcome = {
  proposed?: {
    value: OutcomeValue;
    evidence: string;
    source: "contract" | "research";
    citations?: { id: string; url: string; title: string; publishedAt: string }[];
    at: string;
  };
  confirmed?: { value: OutcomeValue; at: string; by: "user" | "expiry" };
  contractPayout?: { value: number; at: string };
};
export type Question = {
  ideaId: string;
  parentQuestionId?: string;
  text: string;
  criteria: Criteria;
  deadline: string;
  topic: Topic;
  searchTerms?: string[];
  stage: Stage;
  forecasts: Forecast[];
  watch?: import("./record").WatchState;
  outcome?: Outcome;
  createdAt: string;
  updatedAt: string;
};
export type Idea = { text: string; topics: Topic[]; questionIds: string[]; createdAt: string };

export type Venue = "polymarket" | "kalshi";
export type FitStatus = "matches" | "differs";
export type Fit = { status: FitStatus; reason: string };
export type RuleFit = { wording: Fit; deadline: Fit; source: Fit };
export type MatchLevel = "exact" | "close" | "related";
/** What a price check needs to read the contract's books and fees. */
export type VenueData = {
  tokenIds?: { yes: string; no: string };
  fee?: { rate: number; exponent: number };
  seriesTicker?: string;
};
export type Candidate = {
  venue: Venue;
  contractId: string;
  title: string;
  rules: string;
  resolutionSource?: string;
  deadline?: string;
  url: string;
  venueData?: VenueData;
};
export type Match = {
  questionId: string;
  venue: Venue;
  contractId: string;
  title: string;
  rulesExcerpt: string;
  deadline?: string;
  url: string;
  venueData?: VenueData;
  fit: RuleFit;
  level: MatchLevel;
  /** Position in the search's ranking; orders matches within a level. */
  rank?: number;
  status: "active" | "superseded" | "changed" | "delisted";
  foundAt: string;
};

/** At most this many Questions from one idea are active at once. */
export const maxActivePerIdea = 3;
/** Matches kept per search, best level first. */
export const maxMatches = 3;
/** A contract deadline within this many hours of the Question's counts as the same deadline. */
export const deadlineToleranceHours = 48;
export const rulesExcerptLength = 1500;

const zoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
/** Deadlines carry an explicit time zone so "by June 30" is unambiguous. */
export const isZonedDeadline = (value: string) => zoned.test(value) && !isNaN(Date.parse(value));

export const isActive = (stage: Stage) => stage !== "resolved" && stage !== "archived";

export const plainDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

export const deadlineFit = (questionDeadline: string, contractDeadline?: string): Fit => {
  if (!contractDeadline || isNaN(Date.parse(contractDeadline)))
    return { status: "differs", reason: "The contract does not state an end date." };
  const gapHours = Math.abs(Date.parse(contractDeadline) - Date.parse(questionDeadline)) / 3.6e6;
  return gapHours <= deadlineToleranceHours
    ? { status: "matches", reason: `Both end on ${plainDate(questionDeadline)}.` }
    : {
        status: "differs",
        reason: `The contract ends on ${plainDate(contractDeadline)}; your question runs to ${plainDate(questionDeadline)}.`,
      };
};

/** exact: all three match. close: the wording matches but the deadline or source differs. related: the wording differs. */
export const matchLevel = (fit: RuleFit): MatchLevel =>
  fit.wording.status === "differs"
    ? "related"
    : fit.deadline.status === "matches" && fit.source.status === "matches"
      ? "exact"
      : "close";

const levelOrder: Record<MatchLevel, number> = { exact: 0, close: 1, related: 2 };
export const byLevel = <T extends { level: MatchLevel }>(left: T, right: T) =>
  levelOrder[left.level] - levelOrder[right.level];

const stopwords = new Set(
  "a an and are as at be before between by do does during for from has have how if in into is it its of on or over per than that the their there this to under until up was what when which who will with within without would yes no more less least most above below after end".split(
    " ",
  ),
);
export const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%.$\s-]/gu, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((word) => word.length > 1 && !stopwords.has(word));

/** Fallback search phrases when the interview did not record any: salient words, long and short. */
export const searchTermsFor = (question: Pick<Question, "text" | "searchTerms">) => {
  if (question.searchTerms?.length) return question.searchTerms.slice(0, 3);
  const salient = words(question.text).filter((word) => !/^\d{4}$/.test(word));
  return [...new Set([salient.slice(0, 6).join(" "), salient.slice(0, 3).join(" ")])].filter(
    Boolean,
  );
};

/** Prefers contracts sharing the most words with the Question, then the nearest deadline. */
export const rankCandidates = (
  candidates: readonly Candidate[],
  question: Pick<Question, "text" | "deadline" | "searchTerms">,
  limit: number,
) => {
  const terms = new Set([...words(question.text), ...(question.searchTerms ?? []).flatMap(words)]);
  const target = Date.parse(question.deadline);
  const seen = new Set<string>();
  return candidates
    .filter((candidate) => {
      const id = `${candidate.venue}:${candidate.contractId}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((candidate) => ({
      candidate,
      overlap: words(candidate.title).filter((word) => terms.has(word)).length,
      distance: candidate.deadline ? Math.abs(Date.parse(candidate.deadline) - target) : Infinity,
    }))
    .sort((left, right) => right.overlap - left.overlap || left.distance - right.distance)
    .slice(0, limit)
    .map(({ candidate }) => candidate);
};

/** A search moves an early-stage Question forward; watched or positioned Questions keep their stage. */
export const stageAfterMatch = (stage: Stage, hasExact: boolean): Stage =>
  ["forecast", "briefed", "matched", "unmatched"].includes(stage)
    ? hasExact
      ? "matched"
      : "unmatched"
    : stage;
