# Polymancer

**Bring an idea. Leave with a forecast you can stand behind.**

Polymancer is a thinking partner for people with views about the world.

- You talk an idea through, and it becomes a dated Question you can settle.
- Polymancer researches both sides and finds the Polymarket or Kalshi contract that really asks it.
- It says honestly whether the market disagrees with the evidence after costs.
- It watches the Question quietly, and keeps a scored record of your forecasts.

Paper only; real money is a later opt-in.

## Docs

| Doc                                      | Owns                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [docs/product.md](docs/product.md)       | Who it's for, the promise, principles, positioning, business model, success measures                              |
| [docs/experience.md](docs/experience.md) | Places, layouts, the loop, the first session, coming back, resolution, Record, call cards                         |
| [docs/interface.md](docs/interface.md)   | Components, visual rules, states, build priority, accessibility                                                   |
| [docs/agent.md](docs/agent.md)           | Voice and judgment: interview, research, matching, price check, paper, watch and resolution rules                 |
| [docs/system.md](docs/system.md)         | The build contract: state, stages, settings, runtime surfaces, data sources, math, scoring, errors, platform work |
| [docs/roadmap.md](docs/roadmap.md)       | Milestones M1–M3, later tracks, and the validation test                                                           |
| [CONTEXT.md](CONTEXT.md)                 | Glossary                                                                                                          |

When docs disagree on a number or rule, `system.md` wins for mechanics and `agent.md` wins for judgment.

## What the code does today

M1's loop is built ([roadmap](docs/roadmap.md#m1-idea-loop-on-paper-web-console)): ideas to matched markets (#29), briefs, price checks and paper positions (#30), and the watch, outcomes and Record (#31). Its exit criteria still need a session against live venues with a real model; everything so far is verified on recorded fixtures. It is the product's default agent (`config/product.json`), one per workspace, on the Operloom Runtime Module contract with no core edits.

| Surface   | What it does                                                                                                                                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat      | Interviews the user into Questions; tools for every step below except archive; grounded in `polymancer.questions` and `polymancer.portfolio`                                                                                |
| Workflows | `question.save`, `forecast.commit`, `match.find`, `question.adopt`, `brief.create`, `price.check`, `position.open`, `position.close`, `question.watch`, `outcome.confirm`, `question.archive`, and the `watch.tick` monitor |
| Queries   | `polymancer.questions`, `polymancer.question`, `polymancer.portfolio`, `polymancer.record`, `polymancer.operator-state` (copy experiment)                                                                                   |
| State     | `idea`, `question`, `match`, `brief`, `pricecheck`, `position`, `account`, `budget`                                                                                                                                         |
| Card      | Every Question surface returns the `polymancer.question` artifact (question, matches, latest brief and price check, open position); `web.ts` renders the Question card                                                      |
| Settings  | The M1 set from [system.md](docs/system.md#settings)                                                                                                                                                                        |
| Decisions | One entry per save, forecast, search, adoption, brief, price check, position and skip (`/v1` state entries, `type=decision`); fills are `effect` entries                                                                    |

`match.find` needs a committed forecast. It searches Polymarket (Gamma
`/public-search`) and Kalshi (site series search, then the documented events
API), drops sports, closed, non-binary and combo contracts, and ranks
candidates by shared words and deadline distance. One structured model call
judges wording and resolution source for up to eight candidates; the deadline is
checked in code (within 48 hours counts as the same). It keeps three matches,
best level first, and never returns prices. If one venue fails the other's
results stand; if both fail the run fails with `venues_unavailable` and nothing
changes.

`brief.create` runs three dated web searches through the Operloom search port
(cutoff = research time), then one structured call with `includeContext: false`,
so the model sees only the Question, its criteria and the numbered sources,
never the user's forecast or a price. Points without a valid source id are
dropped; citations come from retrieval metadata. No dated sources gives a
"not enough evidence" brief without a model call. Local runs need `EXA_API_KEY`
in `cloudflare/control-plane/.dev.vars`.

`price.check` (exact matches only, after a forecast) walks the live book for
both outcomes up to the maximum loss, within 2 points of the best ask, adds
taker fees, and records the verdict, the gaps at the user's forecast and at
Polymancer's point, and the YES mid. `position.open` needs a check under 5
minutes old, re-walks the book, and skips (decision with a code, no fill) on
`slippage_exceeded`, `insufficient_depth`, `insufficient_cash` or
`max_open_positions`. `position.close` sells down the bids. Paper cash starts
at the `paperCash` setting when the first position opens.

`question.watch` ("save and watch") and the first paper position install the
`watch` monitor through `context.triggers.ensure`. Each minute `watch.tick`
reads the exact contract of every watched Question (Gamma markets, Kalshi
market), then:

- alerts at most once a day per Question (decision plus a `watch.alert` event)
  for a move of `priceAlertPoints` from the baseline (re-taken when the user
  marks the Question seen), a fired date or price signpost, a rules change (the
  exact match drops to close), or a deadline a week away;
- on a price move or signpost, re-researches one Question per tick within
  `researchRunsPerDay`, at most once a day per Question, and records the
  suggestion (keep, revise, hold or consider closing); over budget it records
  `research_skipped` with its code;
- marks open positions, and when the contract settles it settles the paper
  position at the payout exactly once and proposes the outcome from the
  contract;
- past the deadline with nothing settled (three days' grace for an exact
  match), researches the outcome against the Question's criteria and proposes
  it with citations; an unconfirmed proposal becomes unresolvable after 14
  days;
- after three failed reads marks the watch stale.

`outcome.confirm` resolves the Question (before the deadline only a YES).
`polymancer.record` scores confirmed yes/no Questions: Brier and hit rate for
the original forecast, the latest revision, Polymancer's first brief and the
market's mid at the first price check, each with its count; calibration buckets
with Wilson bands from 20 resolved; paper PnL separately.

The **copy-trading experiment** (paper copies of tracked wallets) is still in
the package for the later power-user track, but no longer reachable from chat:
`copy.start`, `copy.sync`, `heartbeat` and the `wallet-activity` and
`heartbeat` monitors remain workflows, on their own `copy_position` and
`copy_account` ledger read through `polymancer.operator-state`.

Paper execution runs only when the agent's effect target is `simulation`. Under
`external` the paper workflows fail closed with `live_trading_unavailable`; no
live order binding exists.

## Clients

Polymancer is frontend-agnostic: every capability is a workflow, query, setting or state read on `/v1` (`@operloom/client`).

- **Web console:** now.
- **ChatGPT app:** M2; research and paper only.
- **Mobile:** M3, at full parity with the web console.

Client work that isn't Polymancer-specific (a mobile shell, the MCP adapter, notification delivery, inline chat renderers) goes to Operloom and merges down. Live trading prerequisites are listed in [docs/system.md](docs/system.md#operloom-platform-work).

`domain.ts` holds the pure fill, risk, heartbeat and copy-translation logic.
`domain.test.ts` ports the original backend's expected values;
`acceptance.test.ts` runs the full loop on `createPackTestRuntime`.
