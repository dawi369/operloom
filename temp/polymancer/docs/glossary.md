# Polymancer glossary

Definitions only. The product is described in [docs/](docs/); decisions are on the planning map (GitHub issue "Wayfinder: Polymancer v1 product and technical plan").

## Core product

- **Idea-holder**: the primary user. Someone with views about the world who rarely trades prediction markets.
- **Idea**: what a user brings to the conversation, in their own words. It may yield several Questions.
- **Question**: a falsifiable, dated question sharpened from an Idea, with resolution criteria. The lasting object. (Older tickets call it a "claim".)
- **Child Question**: a Question created from a close contract's exact terms, so it can be checked against that contract.
- **Resolution criteria**: the source, definitions and fallback that decide a Question's outcome.
- **Forecast**: the user's timestamped probability for a Question. The original is immutable; later ones are revisions.
- **Estimate**: Polymancer's probability for a Question, given as a range with a point.
- **Brief**: Polymancer's two-sided research on a Question: base rate, cases for and against, signposts, sources and estimate.
- **Base rate**: how often comparable events happened, from a stated reference class.
- **Signpost**: an observable development named in a Brief that would change the estimate. Watch checks signposts.
- **Match**: a venue contract considered for a Question, with rule fit on wording, deadline and resolution source. It has a level:
  - **Exact**: all three match.
  - **Close**: the wording matches, but the deadline or source differs.
  - **Related**: the wording differs; context only.
- **Price check**: an optional comparison of the Estimate with the market after spread and fees, on an Exact match. Its verdict is Possible edge, No edge or Not enough evidence.
- **Edge**: a gap between the Estimate and the market after costs that clears the buffer.
- **Paper position**: an opt-in simulated position on an Exact match, sized from a maximum loss, with its thesis attached. Always labelled PAPER.
- **Watch**: quiet monitoring of a Question's contract, deadline and signposts against its original reasoning.
- **Watch alert**: a message about a material change, with choices. It never acts.
- **Digest**: the optional weekly summary of watched Questions plus up to three new questions in the user's topics.
- **Outcome**: a Question's confirmed resolution against its own criteria. Distinct from a contract's **payout**.
- **Record**: the user's track record: scores, calibration once there is enough history, and paper results, shown separately.
- **Calibration**: how well stated probabilities matched resolved outcomes across many Questions.
- **Call card**: a private-by-default, timestamped summary of a committed forecast that the user may share. Never a tip.
- **Topics**: the areas a user follows (politics, economy, tech and AI, science, world). Sports are out of scope.
- **Venue**: an exchange Polymancer reads from (Polymarket international, Kalshi; later Polymarket US).

## Later: live trading and the power-user track

- **Power-user track**: the later wallet-copy and cohort features for active traders.
- **Strategy**: a user-owned configuration of signals, filters, limits, sizing and an autonomy level.
- **Signal**: an observed event that may justify a trade: a tracked-wallet trade, a cohort entry or a market move.
- **Tracked wallet**: a Polymarket wallet a user follows directly.
- **Cohort**: wallets selected by Polymancer's scoring on resolved outcomes.
- **Candidate**: a proposed trade intent derived from a signal.
- **Gate**: a deterministic check a candidate or paper position must pass (liquidity, slippage, fees, limits).
- **Judgment**: the optional model step that may skip or downsize a candidate, never enlarge it.
- **Decision**: a recorded judgment with its full input snapshot.
- **Order intent**: a sized order routed to paper or live execution under an autonomy level.
- **Autonomy level**: Observe, Propose (each order approved) or Auto (inside limits).
- **Approval**: a user's answer to a Propose order intent. It expires and re-checks gates.
- **Fill model**: the shared pricing of orders by walking the live order book plus fees.
- **Execution lag**: time from a source event to Polymancer's decision and fill.
- **Session key**: a CLOB-scoped, revocable key a Polymarket Deposit Wallet owner authorizes for order signing.
- **Graduation**: meeting the paper evidence that unlocks live Auto for a strategy.
