/** Pure track-record and watch logic: Brier scores, calibration, and watch alerts. No I/O. */

const round = (value: number, places = 4) => Number(value.toFixed(places));

/** Calibration charts appear once this many Questions have resolved. */
export const minCalibrationSample = 20;
/** At most one alert per Question in this window. */
export const alertCooldownMs = 24 * 3_600_000;
/** A proposed outcome the user ignores this long becomes unresolvable and is not scored. */
export const proposalExpiryMs = 14 * 24 * 3_600_000;
/** Consecutive failed venue reads before a watch counts as stale. */
export const staleAfterFailures = 3;

export const brier = (probability: number, outcome: 0 | 1) => round((probability - outcome) ** 2);

/** Wilson score interval for an observed frequency. */
export const wilson = (successes: number, count: number, z = 1.96) => {
  if (!count) return { low: 0, high: 1 };
  const p = successes / count;
  const denominator = 1 + (z * z) / count;
  const centre = p + (z * z) / (2 * count);
  const spread = z * Math.sqrt((p * (1 - p)) / count + (z * z) / (4 * count * count));
  return {
    low: round(Math.max(0, (centre - spread) / denominator)),
    high: round(Math.min(1, (centre + spread) / denominator)),
  };
};

export type Scored = { probability: number; outcome: 0 | 1 };

export const scoreSummary = (items: readonly Scored[]) => ({
  count: items.length,
  meanBrier: items.length
    ? round(
        items.reduce((total, item) => total + brier(item.probability, item.outcome), 0) /
          items.length,
      )
    : null,
  hitRate: items.length
    ? round(
        items.filter((item) => (item.probability >= 0.5 ? 1 : 0) === item.outcome).length /
          items.length,
      )
    : null,
});

/** Ten-point buckets with sample counts and Wilson bands; empty buckets are omitted. */
export const calibration = (items: readonly Scored[]) =>
  Array.from({ length: 10 }, (_, index) => {
    const inBucket = items.filter(
      (item) => Math.min(9, Math.floor(item.probability * 10)) === index,
    );
    if (!inBucket.length) return [];
    const yes = inBucket.filter((item) => item.outcome === 1).length;
    return [
      {
        bucket: `${index * 10}–${index * 10 + 10}%`,
        count: inBucket.length,
        meanForecast: round(
          inBucket.reduce((total, item) => total + item.probability, 0) / inBucket.length,
        ),
        observed: round(yes / inBucket.length),
        ...wilson(yes, inBucket.length),
      },
    ];
  }).flat();

export type ContractStatus = {
  /** YES price, from the venue's quote. */
  price?: number;
  status: "open" | "closed" | "settled";
  /** YES payout once settled: 1, 0, or a split such as 0.5. */
  payout?: number;
  rules?: string;
};
export type Signpost = {
  id: string;
  text: string;
  kind: "evidence" | "date" | "price";
  date?: string;
  threshold?: number;
};
export type WatchState = {
  lastViewedAt?: string;
  lastAlertAt?: string;
  baselinePrice?: number;
  lastPrice?: number;
  failures?: number;
  staleSince?: string;
  deadlineAlerted?: boolean;
  firedSignposts?: string[];
  lastResearchAt?: string;
};
export type Alert = {
  kind: "price_move" | "signpost" | "rules_changed" | "deadline_near" | "resolved";
  text: string;
};

const points = (value: number) => Math.round(value * 100);

/**
 * One watch tick for one Question. Material changes alert at most once a day; a settled
 * contract always reports. `research` is true when a price move or a signpost fired, which
 * is what may trigger budgeted re-research.
 */
export const evaluateWatch = (input: {
  now: number;
  deadline: string;
  watch: WatchState;
  quote?: ContractStatus;
  failed: boolean;
  rulesChanged: boolean;
  signposts: readonly Signpost[];
  alertPoints: number;
}) => {
  const next: WatchState = { ...input.watch };
  const alerts: Alert[] = [];
  const at = new Date(input.now).toISOString();
  if (input.failed) {
    next.failures = (input.watch.failures ?? 0) + 1;
    if (next.failures >= staleAfterFailures && !next.staleSince) next.staleSince = at;
  } else if (input.quote) {
    next.failures = 0;
    delete next.staleSince;
  }
  const price = input.quote?.price;
  if (price !== undefined) {
    next.lastPrice = price;
    if (next.baselinePrice === undefined) next.baselinePrice = price;
  }
  const fired = new Set(input.watch.firedSignposts ?? []);
  for (const signpost of input.signposts) {
    if (fired.has(signpost.id)) continue;
    const dateFired =
      signpost.kind === "date" && !!signpost.date && Date.parse(signpost.date) <= input.now;
    const priceFired =
      signpost.kind === "price" &&
      signpost.threshold !== undefined &&
      price !== undefined &&
      input.watch.lastPrice !== undefined &&
      (input.watch.lastPrice - signpost.threshold) * (price - signpost.threshold) <= 0 &&
      input.watch.lastPrice !== price;
    if (dateFired || priceFired) {
      fired.add(signpost.id);
      alerts.push({ kind: "signpost", text: `Signpost reached: ${signpost.text}` });
    }
  }
  if (fired.size) next.firedSignposts = [...fired];
  const baseline = input.watch.baselinePrice;
  const moved =
    price !== undefined &&
    baseline !== undefined &&
    Math.abs(price - baseline) * 100 >= input.alertPoints - 1e-9;
  if (moved)
    alerts.push({
      kind: "price_move",
      text: `The market moved from ${points(baseline!)}% to ${points(price!)}%.`,
    });
  if (input.rulesChanged)
    alerts.push({ kind: "rules_changed", text: "The contract's rules changed." });
  const untilDeadline = Date.parse(input.deadline) - input.now;
  if (!input.watch.deadlineAlerted && untilDeadline > 0 && untilDeadline <= 7 * 24 * 3_600_000) {
    next.deadlineAlerted = true;
    alerts.push({ kind: "deadline_near", text: "The deadline is a week away or less." });
  }
  const settled = input.quote?.status === "settled" && input.quote.payout !== undefined;
  if (settled) alerts.push({ kind: "resolved", text: "The matched contract settled." });
  const cooling =
    !!input.watch.lastAlertAt && input.now - Date.parse(input.watch.lastAlertAt) < alertCooldownMs;
  const sent = settled ? alerts : cooling ? [] : alerts;
  if (sent.length) {
    next.lastAlertAt = at;
    if (price !== undefined) next.baselinePrice = price;
  }
  return {
    alerts: sent,
    next,
    research: sent.some((alert) => alert.kind === "price_move" || alert.kind === "signpost"),
    settled,
  };
};
