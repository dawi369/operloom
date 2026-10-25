/** The Question card: one payload every client renders, assembled from the Question's records. */
import type {
  RuntimeRecord,
  RuntimeResult,
  RuntimeStatePort,
  RuntimeStateRecord,
} from "@operloom/agent-sdk/control-plane";

import { byLevel, type Match, type Question } from "./questions";
import { key, listAll } from "./store";

type Reader = Pick<RuntimeStatePort, "get" | "list">;
const byQuestion = (state: Reader, kind: string, questionId: string) =>
  listAll(state, kind, { name: "question", value: questionId });
const newest = (records: RuntimeStateRecord[], field: string) =>
  [...records].sort((left, right) =>
    String(right.data[field]).localeCompare(String(left.data[field]), undefined, {
      numeric: true,
    }),
  )[0];

export const activeMatches = async (state: Reader, questionId: string) =>
  (await byQuestion(state, "match", questionId))
    .filter((record) => record.data.status === "active")
    .sort(
      (left, right) =>
        byLevel(left.data as Match, right.data as Match) ||
        Number(left.data.rank ?? 0) - Number(right.data.rank ?? 0),
    );
export const latestBrief = async (state: Reader, questionId: string) =>
  newest(await byQuestion(state, "brief", questionId), "version");
export const latestPriceCheck = async (state: Reader, questionId: string) =>
  newest(await byQuestion(state, "pricecheck", questionId), "checkedAt");
export const openPosition = async (state: Reader, questionId: string) =>
  (await byQuestion(state, "position", questionId)).find((record) => record.data.status === "open");

/** Everything a client needs to draw the card; rules text and venue internals stay out. */
export const loadCard = async (state: Reader, id: string) => {
  const record = await state.get(key("question", id));
  if (!record) return null;
  const question = record.data as unknown as Question;
  const [matches, brief, check, position] = await Promise.all([
    activeMatches(state, id),
    latestBrief(state, id),
    latestPriceCheck(state, id),
    openPosition(state, id),
  ]);
  return {
    question: { id, ...question },
    matches: matches.map((match) => {
      const { rulesExcerpt: _rules, venueData: _venue, ...rest } = match.data as Match;
      return { id: match.key, ...rest };
    }),
    ...(brief ? { brief: { id: brief.key, ...brief.data } } : {}),
    ...(check ? { priceCheck: { id: check.key, ...check.data } } : {}),
    ...(position ? { position: { id: position.key, ...position.data } } : {}),
  };
};

export const cardArtifact = (card: NonNullable<Awaited<ReturnType<typeof loadCard>>>) =>
  ({
    kind: "polymancer.question",
    title: card.question.text.slice(0, 120),
    mimeType: "application/json",
    data: card as unknown as RuntimeRecord,
  }) satisfies NonNullable<RuntimeResult["artifacts"]>[number];

/** A successful result carrying the fresh card, so chat, console and API clients see the same state. */
export const respond = async (
  state: Reader,
  id: string,
  summary: string,
  extra: RuntimeRecord = {},
): Promise<RuntimeResult> => {
  const card = (await loadCard(state, id))!;
  return {
    ok: true,
    output: {
      questionId: id,
      stage: card.question.stage,
      ...(card as unknown as RuntimeRecord),
      ...extra,
    },
    summary,
    artifacts: [cardArtifact(card)],
  };
};
