# Polymancer: system contract

Domain model, stages, settings, runtime surfaces, data sources, math, scoring
and errors. Product, agent policy, experience and interface are in
[polymancer.md](polymancer.md). When numbers disagree, this document wins.
Written against the pre-reset Operloom; re-check route and SDK names against
this repository's `docs/headless-runtime.md` and `docs/agent-packs.md`.

All behavior lives on the `/v1` API (workflows, queries, settings, state), so the web console, the ChatGPT app and mobile are interchangeable clients.

## Domain model

Typed state in the `polymancer` namespace. All of it is new in M1 except `account`, whose shape changes. Field lists name the decision-relevant fields.

| Kind         | Key fields                                                                                                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idea`       | text, topics, questionIds, createdAt                                                                                                                                                                              |
| `question`   | ideaId, parentQuestionId (set when adopted from a contract's terms), text, criteria (source, definitions, fallback), deadline (ISO with time zone), topic, stage, forecasts[], watch, outcome                     |
| `brief`      | questionId, version, estimate (low, high, point), confidence (low, medium, high), baseRate (class, count, timeframe, rate), caseFor[], caseAgainst[], signposts[], citations[], model, researchedAt, sourceCutoff |
| `match`      | questionId, venue, contractId, title, rulesExcerpt, deadline, fit (wording, deadline, source, each matches/differs with a reason), level (exact, close, related), status                                          |
| `position`   | questionId, matchId, venue, side, shares, entryVwap, fees, maxLoss, thesis (forecast, briefVersion, priceCheckId), status (open, closed, settled), mark, payout                                                   |
| `pricecheck` | questionId, matchId, budget, YES and NO fills (shares, VWAP, fees, price after costs), YES mid, verdict, gaps at the user's forecast and Polymancer's point, checkedAt                                            |
| `account`    | paperCash, startingCash, realizedPnl                                                                                                                                                                              |

Nested structures:

- `question.forecasts[]`: `{ probability, low?, high?, reasonFor?, reasonAgainst?, at, kind: original | revision, reason? }`. The original is immutable.
- `question.watch`: `{ lastViewedAt, lastAlertAt, lastAlertedPrice, lastResearchAt, staleSince? }`.
- `question.outcome`:
  - `proposed { value: yes | no | unresolvable, evidence, at }`
  - `confirmed { value, at, by: user | expiry }`
  - `contractPayout? { value, at }`
- `brief.signposts[]`: `{ id, text, kind: price | date | evidence, threshold? }`.
  - `price` and `date` signposts are checked every minute.
  - `evidence` signposts are checked only by budgeted re-research.

**Decision entries** (`type: "decision"`) record every judgment with its inputs:

- price checks with the verdict, VWAP, fees and gaps;
- skipped actions with a reason code;
- watch alerts;
- re-research runs and skips;
- outcome proposals and confirmations.

**Effect entries** record paper fills and settlements. Clients read both through the generic `/v1` state entries API.

## Question stages

| Stage              | Entered when                                                        | Primary next step                                        |
| ------------------ | ------------------------------------------------------------------- | -------------------------------------------------------- |
| `draft`            | Interview saved wording without a forecast                          | Commit forecast                                          |
| `forecast`         | Original forecast committed                                         | Get the brief                                            |
| `briefed`          | A brief version exists (or research reported "not enough evidence") | Find markets, or save and watch                          |
| `matched`          | At least one `exact` match exists                                   | See what the market thinks (optional), or save and watch |
| `unmatched`        | Search found no `exact` match                                       | Save and watch, or forecast a close contract's terms     |
| `watching`         | The user saved and watched                                          | (passive)                                                |
| `positioned`       | A paper position is open                                            | (passive)                                                |
| `awaiting_outcome` | Deadline passed or matched contract settled; outcome proposed       | Confirm outcome                                          |
| `resolved`         | Outcome confirmed (by the user, or `unresolvable` by expiry)        | See in Record                                            |
| `archived`         | The user archived it (before resolution only)                       | None                                                     |

Transitions:

- `watching` and `positioned` both continue watching until the deadline.
- Closing a paper position returns the Question to `watching`.
- A price check never changes the stage; it is recorded as a decision.
- Re-research adds a brief version without changing the stage.
- If the user ignores a proposed outcome for 14 days, it becomes `unresolvable` and is not scored.

**What gets watched:**

- _Matched Questions_: the contract (price, rules, status) plus all signposts.
- _Unmatched Questions_: the deadline and `evidence` signposts only.

## Settings

User-editable through `/v1` settings. M1 replaces all legacy copy-trading settings (`strategyPrompt`, `maxPositionUsd`, `maxOpenPositions`, `priceMoveAbs`, `exposureMovePct`).

| Setting              | Default | Bounds                                            | Notes                                                                                         |
| -------------------- | ------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `topics`             | `[]`    | any of politics, economy, tech_ai, science, world | Drives starters and the digest                                                                |
| `priceAlertPoints`   | 10      | 3–50                                              | Probability points, measured from the later of the last view and the last alert               |
| `digest`             | `off`   | off, weekly                                       | Free gets a weekly check-in of watched Questions regardless                                   |
| `defaultMaxLossUsd`  | 25      | 1–`maxLossCapUsd`                                 | Paper dollars                                                                                 |
| `maxLossCapUsd`      | 100     | 1–1000                                            | Paper dollars                                                                                 |
| `maxOpenPositions`   | 10      | 1–50                                              |                                                                                               |
| `paperCash`          | 1000    | read-only after first position                    | Paper dollars                                                                                 |
| `researchRunsPerDay` | 3       | 0–20                                              | Re-research by the watch monitor; user-requested briefs count against plan allowances instead |

## Runtime surfaces

| Surface                                                 | Kind                                                         | Status                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `polymancer.question.save`                              | model-visible tool                                           | M1 |
| `polymancer.forecast.commit`                            | model-visible tool + workflow                                | M1 |
| `polymancer.match.find`                                 | workflow                                                     | M1 |
| `polymancer.question.adopt`                             | workflow: create a child Question from a close match's terms | M1 |
| `polymancer.question.archive`                           | workflow                                                     | M1 |
| `polymancer.brief.create`                               | workflow (durable when long)                                 | M1 |
| `polymancer.price.check`                                | workflow                                                     | M1 |
| `polymancer.position.open` / `.close`                   | workflow                                                     | M1 |
| `polymancer.question.watch`                             | model-visible tool + workflow: save and watch, or mark seen  | M1 |
| `polymancer.watch.tick`                                 | workflow run by the `watch` monitor (minute)                 | M1 |
| `polymancer.outcome.confirm`                            | model-visible tool + workflow                                | M1 |
| `polymancer.questions`, `polymancer.question`           | queries                                                      | M1                                     |
| `polymancer.portfolio`                                  | query + chat context                                         | M1 |
| `polymancer.record`                                     | query                                                        | M1 |
| `polymancer.digest`                                     | schedule (weekly)                                            | M2                                                                    |
| `copy.start`, `copy.sync`, `heartbeat`, wallet monitors | workflows and monitors                                       | Exist today. Hidden from chat in M1 and kept for the power-user track |

Installation:

- `watch` is installed with `context.triggers.ensure` when a Question is saved and watched or the first paper position opens.
- `digest` is installed when the user opts in.

**Events:** `watch.alert`, `outcome.proposed`, `question.resolved` (M1), and `digest.ready` (M2). In M1 they surface in the console and through webhooks; M2 adds email and push.

## Data sources

Verified on 2026-10-03: Kalshi against its live public API, Polymarket against its official SDK source and archived docs. Everything here is a public read; paper trading needs no venue credentials. M1 tests run on recorded fixtures.

| Need               | Polymarket (international)                                                                                                                                                            | Kalshi (`api.elections.kalshi.com/trade-api/v2`, no auth)                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search             | Gamma `GET /public-search?q=` → `events[].markets[]` (`limit_per_type`, `events_status`, `keep_closed_markets`)                                                                       | No text search in the documented API. Use the website's `GET /v1/search/series?query=` (undocumented, public; returns series with events, markets and fee info). Fallback: a daily index from `GET /series?category=` |
| Market detail      | Gamma `GET /markets?slug=` or `/markets/slug/{slug}`                                                                                                                                  | `GET /events?series_ticker=&status=open&with_nested_markets=true` (cursor pagination, limit 200)                                                                                                                      |
| Rules and deadline | `description`, `resolutionSource`, `endDate`. `outcomes`, `outcomePrices` and `clobTokenIds` are JSON-encoded strings; `tags` is an array                                             | `rules_primary`, `rules_secondary`, `close_time`, `expiration_time`, `category`                                                                                                                                       |
| Order book         | CLOB v2 host `clob-v2.polymarket.com`, `GET /book?token_id=`: `bids` ascending, `asks` descending (best is last), plus `tick_size`, `min_order_size`                                  | `GET /markets/{ticker}/orderbook` → `orderbook_fp.yes_dollars` and `no_dollars` as `[price, size]` strings, **bids only**, ascending. YES ask = 1 − best NO bid                                                       |
| Fees               | Per market: Gamma `feeSchedule` (`rate`, `exponent`, `takerOnly`) or CLOB `GET /clob-markets/{conditionId}` (`fd`). Makers pay nothing; some categories are fee-free                  | Series `fee_type` (for example `quadratic`) and `fee_multiplier`                                                                                                                                                      |
| Settlement         | `umaResolutionStatus` (`proposed`, `disputed`, `resolved`, `settled`), `closed`, `outcomePrices` 1/0 (rarely 0.5/0.5). About 2 hours after an undisputed proposal; disputes take days | `status: finalized`, `result: yes \| no`, `settlement_value_dollars`                                                                                                                                                  |
| Rate limits        | Gamma `/public-search` 350 and `/markets` 300 per 10 s; CLOB `/book` 1,500 per 10 s (archived docs)                                                                                   | Anonymous limits undocumented; back off on 429                                                                                                                                                                        |
| Exclusions         | Sports tags                                                                                                                                                                           | Categories `Sports`, `Mentions`, `Exotics`; multivariate combo events (`KXMVE…`)                                                                                                                                      |

Reads run in Workers with plain `fetch`. The Polymarket ts-sdk waits for live trading and runs in the signed runner.

**Development network note:** some ISPs block Polymarket hosts. The owner's current network (O2 Czech Republic) redirects them to a block page. Local development uses recorded fixtures for Polymarket. Live Polymarket reads must be checked from the deployed Worker; bypassing a national block is not part of the workflow.

## Research

Retrieval and reasoning are separate steps, so every citation comes from retrieval metadata and never from the model.

1. **Retrieve** through the Operloom web-search port, backed server-side by **Exa**:
   - about $0.007 per search with up to 10 results;
   - returns `publishedDate`;
   - supports `endPublishedDate` and `snapshotAsOf` for a source cutoff;
   - fetch-only REST, so it runs in Workers.

   Results without a date, or dated after the cutoff, are dropped.

2. **Reason** with a structured model call through OpenRouter (existing `models.structured`). The model receives only the retrieved evidence and source ids, plus the Question and its criteria. It never sees the user's forecast or any market price.

| Brief                   | Steps                                                                             | Model (verify on OpenRouter) | Cost (estimate) |
| ----------------------- | --------------------------------------------------------------------------------- | ---------------------------- | --------------- |
| Standard                | 3 searches (base rate, for, against) + 1 structured call                          | Gemini 2.5 Flash             | about $0.03     |
| Deep (durable workflow) | 8 searches, content extraction, independent drafts, adversarial review, synthesis | Gemini 3.1 Pro               | about $0.50     |

- Usage is reserved and settled through Operloom budgets.
- **Evaluation** is prospective: forecasts are stored before resolution, then scored with Brier against base-rate and market baselines. Source cutoffs cannot remove what a model memorized, so backtests are only a sanity check.
- **Expectation:** in Prophet Arena (2025), the best models' Brier scores (about 0.184) were close to the market's (0.187). Polymancer's estimate will rarely beat a liquid market; "Possible edge" should be rare, and the product's value is the reasoning and the record.

## Price-check math

For buying N shares of one outcome by walking the book:

```text
VWAP        = Σ(level price × level shares) / N     (stop at N, or at the slippage limit)
fees        = venue fee for the fill                (read per market)
exec price  = (N × VWAP + fees) / N                 (shown as "market after costs")
gap(p)      = p − exec price                        (per share, for probability p)
EV(p)       = N × gap(p)
```

- **Slippage limit:** stop the walk when the next level is more than 2 points above the best ask. The size shown is the largest that fits.
- **Quote freshness:** a price check is valid for 5 minutes. `position.open` refuses older ones.
- **Kalshi asks:** the book lists bids only. Walking YES asks means walking NO bids from the best down, at price 1 − NO bid; buying NO is the mirror image.
- **Fee models** (paper fills are taker fills, computed per book level and summed):
  - Polymarket: `fee = N × rate × (p × (1 − p))^exponent`, with `rate` and `exponent` read per market. Category rates differ between docs and SDK tests, so they are never hard-coded.
  - Kalshi: `quadratic` series fee = `ceil₀.₀₁(k × fee_multiplier × C × P × (1 − P))`, P in dollars. The coefficient k (0.07 for takers in past schedules) is still unverified because the fee schedule PDF could not be fetched; keep it a configuration value.
  - A market with no published fee schedule is priced without fees and the check records `feeKnown: false`, so clients can say so.

## Scoring

- **Brier** per resolved Question: `(p − outcome)²`, outcome 1 or 0. Lower is better; a constant 50% scores 0.25.
- **The user's headline score** uses the original forecast. Revision scores are tracked separately to show whether updating helped.
- **Polymancer's score** uses the point estimate of the first brief.
- **Market benchmark:** scored only for Questions with an `exact` match, using the executable mid at the first price check. Otherwise it is omitted, never imputed.
- **Calibration** is shown once 20 or more Questions have resolved: buckets with Wilson intervals and sample counts. Below that, the Record shows per-question scores and running averages only.
- **Paper PnL** comes from contract payouts and is never mixed into forecast scores.

## Errors and staleness

| Condition                                      | Behavior                                                                                                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Venue request fails                            | Keep the last good quote with its age and retry on the next tick. `question.watch.staleSince` is set after 3 consecutive failures. No user alert for staleness; the card shows it |
| Venue data stale over 30 minutes               | Price checks and paper positions are disabled for that match until fresh                                                                                                          |
| Research call fails or the budget is exhausted | Record a skip decision with a reason. A user-requested brief shows the error and keeps the previous version                                                                       |
| Matched contract delisted or rules changed     | Alert once, and set the match `status` to `changed` (a rules change) or `delisted`. A changed exact match drops to `close` until the user re-confirms it                          |
| Book too thin for the requested max loss       | Offer the largest size within the slippage limit; otherwise `no edge`                                                                                                             |

## MCP allowlist

The MCP tool allowlist is product configuration: read queries, `forecast.commit`, `question.save`, `brief.create`, `match.find`, `question.adopt`, `price.check` and the paper `position` workflows.

## Platform dependencies

Everything the pack needs is native in Operloom 2.1: web search with dated
results and cutoffs, structured model calls without run context, package
triggers, pack tool-result renderers, notification delivery, billing and
entitlements, provider operations with receipts and policy-controlled
approvals. See `docs/capabilities.md` in this repository for status.

## Verify at build time

- The Kalshi quadratic fee coefficient, and whether Kalshi's undocumented series search stays available.
- The Polymarket book host: the code reads `clob.polymarket.com/book` (the long-standing public host and the pack fixtures); confirm it against the v2 host above from the deployed Worker.
- Live Polymarket reads from the deployed Worker.
- Written data-use permission from Polymarket, and Kalshi's Developer Agreement, before any public launch.
- OpenRouter availability and prices of the chosen models.
- OpenAI app review of the research-and-paper scope.
- The legal read before any live trading.
