# Polymancer

**Bring an idea. Leave with a forecast you can stand behind.**

A thinking partner for people with views about the world who rarely trade
prediction markets. You talk an idea through; Polymancer turns it into a
question that can be settled, researches both sides, finds the Polymarket or
Kalshi contract that really asks it, says honestly whether the market disagrees
with the evidence after costs, and keeps a scored record of how your thinking
performed. The record is the product; the market is an instrument.

This file is the product, agent and experience spec. Numbers, schemas, math and
venue details live in [system.md](system.md); when they disagree, system.md wins.

## Glossary

- **Idea**: what the user brings, in their own words. May yield several Questions.
- **Question**: a falsifiable, dated question with resolution criteria (source,
  definitions, fallback). The lasting object. A **child Question** is created
  from a close contract's exact terms.
- **Forecast**: the user's timestamped probability. The original is immutable;
  later ones are revisions. **Estimate**: Polymancer's range plus point.
- **Brief**: two-sided research: base rate, case for, case against, signposts,
  dated sources, estimate. **Signpost**: an observable that would change it.
- **Match**: a venue contract with rule fit on wording, deadline and resolution
  source. Levels: **exact** (all three), **close** (wording only), **related**
  (context only).
- **Price check**: the estimate against the market after spread, fees and
  depth, on an exact match. Verdict: **Possible edge**, **No edge**, **Not
  enough evidence**.
- **Paper position**: opt-in simulated position sized from a maximum loss, with
  its thesis attached, always labelled PAPER.
- **Watch** / **watch alert** / **digest**: quiet monitoring; a message about a
  material change that never acts; the optional weekly summary.
- **Outcome**: the Question's confirmed resolution against its own criteria,
  distinct from a contract's **payout**. **Record**: scores, calibration once
  there is enough history, paper results shown separately. **Call card**: a
  shareable, timestamped committed forecast; never a tip.
- Later, the **power-user track**: tracked wallets, scored cohorts, strategies
  with gates, candidates, approvals and autonomy levels (Observe, Propose,
  Auto), session keys and graduation from paper to live.

## Who, promise, principles

The **idea-holder** follows politics, the economy, tech and AI, science or world
events, has opinions they think are good, and does not want another feed or a
betting product. Active traders come later.

Every session ends in one of three complete outcomes: a sharper Question with
your forecast on record; a price check where "no edge" is a good answer; or a
paper position with a stated maximum loss, watched quietly until it resolves.

Principles that settle scope and design arguments:

1. **Your view comes first.** The forecast is recorded before any estimate or price.
2. **Three numbers, never blended.** Your forecast, Polymancer, Market: separate, labelled, in that order.
3. **Argue both sides** with dated sources and "what would change this".
4. **The contract is not your question.** Rule fit is shown before any price.
5. **Honest about edge.** A gap counts only after spread, fees and depth.
6. **Quiet by default.** Reach out only on material change or an opted-in digest.
7. **Paper first, always labelled.** Real money is a later, separate opt-in.
8. **Score the thinking, not the payout.** Accuracy and calibration lead; paper PnL is secondary.
9. **You decide.** Never "you should buy", never urgency, never a forecast changed on the user's behalf.

Not: a tip service, a market browser or leaderboard, a sportsbook (sports are
out of scope), a wallet or custodian.

**Business model (hypothesis):** Free (a few questions a month, standard
research, paper, weekly check-in, ChatGPT app); Plus about $9–12/month (more
questions, deep research, daily watch, alerts, full record, call cards); Pro
about $29/month later (live trading, each trade approved; power-user track).
Deep research beyond allowance is pay-per-use (standard brief ≈ $0.03, deep ≈
$0.50 in provider fees). No performance fees, no per-trade markup; subscriptions
are the business.

**Success measures:** activation (a Question with a forecast saved in the first
session); trust (share of "no edge" checks the user stays through); return
(back after an alert and on resolution day); record (5+ resolved Questions at
90 days); conversion (Free → Plus after the first resolved Question).

## Voice and guardrails

A careful analyst who respects the user's judgment: plain and specific (short
sentences, concrete numbers with plain-language odds, dates on every fact);
two-sided; calibrated ("I don't know", "not enough evidence", "no edge" and
"this contract doesn't ask your question" are useful answers); always
attributes a number ("your forecast", "my estimate", "the market"); neutral
about action ("If you wanted to put this to work…"); calm, never celebrating or
consoling.

Hard guardrails: real money is never discussed as available unless the user is
enrolled in live trading; no sports markets; never change a forecast or
position on the user's behalf.

Phrases it uses: "Before I share mine: how likely do you think this is?" ·
"Here's the strongest case against your view." · "This contract ends in
December; your question runs to June. Want to forecast the contract's version
too, before we look at its price?" · "No edge: after costs, the market's price
is within my range. Saving the question is a good outcome." · "Nothing material
changed this week."

## Protocols

**Interview.** Hear the idea in the user's words. Ask for what is missing, one
question per turn: subject, measurable event or threshold, deadline with time
zone, geography or population, what would show it happened. After three turns
without convergence, offer two concrete readings or save a draft. Draft "Will
[observable event] happen by [date, time zone], as reported by [source]?" with
definitions, edge cases and a fallback source; an idea may yield several
Questions, at most three active. The user confirms or edits the wording;
after a forecast is committed, wording changes create a new Question. Then
elicit the unaided forecast (probability, optional range, strongest reason each
side) before showing any estimate, base rate or price, and commit it with a
timestamp.

**Brief.** Retrieval and reasoning are separate steps: dated search results
are retrieved first (anything undated or after the source cutoff is dropped)
and the model reasons only over them, never seeing the user's forecast or any
market price. Record context (Question, criteria, research time, cutoff).
Outside view: a reference class with its inclusion rule, count, timeframe and
base rate, or "no defensible class". Decompose only when it helps. Inside view:
facts separated from inference; strongest evidence for and against, each citing
a retrieved source id (URLs, titles and dates come from retrieval metadata).
Update from the base rate in named steps. Estimate: range plus point, two or
three signposts (which become watch triggers), confidence low/medium/high from
evidence quality. Self-check: every key fact cited; no hedging to 50% against
strong evidence; no drifting above 50% without reason. Polymancer expects to be
about as accurate as a liquid market, not better, and says so when asked.

**Matching.** Search Polymarket and Kalshi by key terms and deadline window,
sports excluded. Score wording, deadline and resolution source (each matches or
differs with one sentence) into exact / close / related; keep up to three, best
first; with no exact match say so. For a close match, offer to **forecast the
contract's terms**: draft a child Question with the contract's wording,
deadline and source, take a fresh forecast before any price, update the brief.
Price checks and paper positions run only on exact matches.

**Price check** (optional; saving and watching is always complete). Executable
price comes from walking the book for the intended size plus venue fees, never
last trade or mid. Verdict, in order: **Not enough evidence** if confidence is
low or the range is wider than 30 points; **Possible edge** if the near end of
the range clears the executable price by at least the 3-point buffer (YES: low
end above price + buffer; NO: high end below price − buffer); otherwise **No
edge**. Report the gap at the user's forecast and at the point estimate,
labelled separately.

**Paper position.** Explicit opt-in, never proposed after "no edge". The user
sets a maximum loss; shares derive from the executable price, capped by depth
within the slippage limit. The thesis (Question, forecast, brief version, price
check) is stored. Early close fills at the executable bid with the user's reason.

**Watch.** A cheap check runs every minute. Material changes alert at most once
per Question per day: price crosses `priceAlertPoints`; a `price` or `date`
signpost fires; contract rules, status or deadline change; 7 days to the
deadline; the market resolves. `evidence` signposts are checked only by
re-research, run on a fired signpost or a threshold price move, at most once per
Question per day within `researchRunsPerDay`; skips are recorded. Alerts
explain the change against the original reasoning and offer keep / revise
forecast / close paper position / mute. They never act.

**Resolution.** When the deadline passes or the contract settles, propose an
outcome against the Question's own criteria with evidence; the payout is
evidence, not the answer. The user confirms, corrects or marks unresolved; only
confirmed outcomes are scored. The paper position settles on the payout,
reported separately. A child Question settles on its contract; the parent
resolves on its own deadline.

## Experience

Three places, identical on every client: **Ask** (chat, home), **Questions**
(Drafts, Watching, Resolved; opening one shows its dossier), **Record**. On the
web the dossier is a side panel following the Question under discussion and a
sheet on narrow screens; in the ChatGPT app the Question card is an inline
widget (no real-money orders, no trade links, upgrades on the web); mobile has
full parity plus push alerts that open on the changed Question.

The loop: idea → Question + your forecast → brief + estimate → revise? →
match + rule fit → (exact) price check? → (possible edge) paper? → save and
watch → alerts / digest → you confirm the outcome → Record. Every exit is a
complete outcome.

A first session, condensed: "The EU AI Act enforcement is going to slip" →
three clarifying questions → "Will the EU formally delay the AI Act's
general-purpose AI obligations beyond August 2, 2027, by June 30, 2027?" → user
commits 70% with a reason each side → brief: base rate, both cases, signposts,
estimate 55–65% (60%) → user keeps 70% → Polymarket contract is *close* (ends
Dec 2026), Kalshi *related* → user forecasts the contract's version at 45%,
brief updates to 35–45% → optional price check: market after costs 31% →
Possible edge → opt-in paper position with max loss $25, card turns PAPER ·
Watching → Polymancer says what it will watch and that it will stay quiet
otherwise. With no close contract, the Question is saved and watched; with "no
edge", it ends at save and watch.

Coming back: alerts only on material change, each ending in a choice; the
opt-in weekly digest lists watched Questions and up to three new questions in
the user's topics, each asking for a forecast before any price; silence is a
feature. Resolution day adds a "what would you do differently?" prompt. The
Record shows per-question scores in words ("lower is better; a coin flip scores
0.25") with sample counts, calibration with uncertainty bands once there is
enough history, and paper results second. A call card (private by default)
holds the Question, criteria, commit time, forecasts, labelled snapshot of
estimate and market, a one-line rationale and later the outcome; never size,
profit, "buy" language or a trade link.

## Interface

Shared rules: one card that reflows from a ChatGPT widget to the desktop
dossier, no hover-only controls; three labelled numbers in a fixed order;
plain-language odds ("60% · about 6 in 10"); a persistent PAPER label and icon,
paper balances never summed with real money; no market theatre (no confetti,
streaks, countdowns, flashing, "trending"), motion only to explain a change;
every component has empty, working and error states; status never by colour
alone; 4.5:1 contrast; 44 px targets; reduced motion respected; every chart has
a table equivalent. (The console no longer draws keyboard focus; rely on order
and aria state rather than rings.)

Components, in build order, each with its biggest element and primary action:

1. **Question card**: the question in one line, then deadline; primary action
   follows the stage (Commit your forecast → Get the brief → Find markets →
   Save and watch → Review changes → Confirm the outcome → See in Record; close
   match: Forecast the contract's version; Put it to work on paper only after
   Possible edge, as secondary). Expanded: forecast history, then Brief, Match,
   Price check, Paper summaries.
2. **Contract match**: the Question and the contract wording one above the
   other; three rule-fit rows with ✓/✗ and a sentence; level badge; Exact → Use
   this contract, Close → Forecast the contract's version; empty state keeps
   Save and watch primary; a contract is never substituted silently.
3. **Paper position**: maximum loss first, then the thesis; derived shares,
   entry after costs and both outcomes in words ("If Yes: +$34 paper. If No:
   −$25 paper."); Record paper position disabled until match and price are
   fresh; short undo; no emphasis for larger sizes.
4. **Price check**: the verdict, then the three numbers, market after costs for
   the size, both gaps, quote age; Save and watch primary; "No edge" neutral in
   tone and colour.
5. **Brief**: balanced bottom line, "what would change this", then base rate,
   case for, case against, facts vs inference, dated sources with links;
   sections fill as they complete; errors keep completed sections.
6. **Record**: resolved count and running averages (yours, Polymancer's, the
   market's where exact) with sample sizes; calibration with bands once past the
   threshold; paper PnL second; filters by topic and period; empty state names
   the next deadline.
7. **Forecast control** and **watch alert** (what changed in one sentence, what
   it means, current numbers, keep / revise / close / mute).

Components 2–6 ship first as structured chat markdown and generic state views,
then upgrade in that order.

## Milestones

- **M1 · Idea loop on paper (web console).** The whole loop end to end for one
  user. Exit: acceptance tests cover the loop on recorded fixtures including
  replay safety and two isolated users; the first session above works against
  live venue data (Kalshi locally, Polymarket from the deployed Worker);
  `verify:fast` passes. Written data-use permission from Polymarket and
  Kalshi's developer agreement before any public launch, even paper-only.
- **M2 · Reach.** ChatGPT app (MCP, research-and-paper scope only), Question
  card widget and inline chat card, weekly digest and check-in, email alerts,
  call cards, topics onboarding. Exit: the paper loop runs inside ChatGPT and
  alerts arrive outside it.
- **M3 · Business.** Free and Plus with research allowances and pay-per-use
  deep research; mobile at web parity with push; Polymarket builder program and
  Kalshi builder grants. Exit: first paying users, conversion measured.
- **Later.** Live trading (Pro) after the legal read, custody of session and
  API keys, and the platform's effect operations, policy-controlled approvals
  and runner signing, each trade approved. Power-user track. Public profiles of
  call cards.

**Validation before M3.** The weakest assumption is that non-traders value a
slow, honest record enough to return. During M1–M2, recruit 10–20 idea-holders
in politics, economy and tech; over four weeks measure Questions saved, "no
edge" checks without drop-off, returns after alerts, digest opens, outcome
confirmations; interview each. Continue if at least half return unprompted or
from an alert in week 3 or 4 and several ask for more research; rethink if use
is one-shot (then it is a research tool, not a notebook).
