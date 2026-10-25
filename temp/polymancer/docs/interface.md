# Polymancer: interface

The components that make Polymancer feel crafted. They are rendered the same way inline in chat, in the web dossier and as ChatGPT widgets. The flows that use them are in [experience.md](experience.md).

## Shared rules

- **One card, every surface.** A single column that reflows from a ChatGPT widget to the desktop dossier. There are no hover-only controls and no side-by-side columns that break on narrow widths.
- **Three numbers, three labels.** **Your forecast**, **Polymancer** and **Market** always appear as separate labelled rows, in that order. Never average them, and never show one without its label.
- **Plain-language odds.** Every probability is shown with words: "60% · about 6 in 10".
  - Polymancer's estimate is a range with its point: "55–65% (60%)".
  - Probabilities stop at whole percent; no decimals.
- **PAPER marking.** Paper positions carry a persistent PAPER text label and a dedicated icon, not colour alone. Paper balances live in their own section and are never summed with real money.
- **No market theatre.** No confetti, streaks, countdowns or green and red flashing, and no "hot" or "trending" lists. Motion only explains a change: the changed field highlights briefly, and screen readers announce it.
- **States everywhere.**
  - _Empty_: names what is missing.
  - _Working_: shows what is being checked and the sections already done.
  - _Error_: keeps the last good result and offers a retry.
  - _Stale_: shows the age and what changed.

## Components

### 1. Question card (built first)

The durable object, and the only custom component M1 needs to feel finished.

- **Biggest:** the question in one line, then its deadline.
- **Primary action** follows the stage table in [system.md](system.md#question-stages): Commit your forecast → Get the brief → Find markets → Save and watch (with an optional See what the market thinks) → Review changes → Confirm the outcome → See in Record. For a close match the action is **Forecast the contract's version**. **Put it to work on paper** appears only after a Possible edge verdict, as a secondary action.

- **Collapsed:**
  - Before a forecast exists: the question, the deadline and only the forecast prompt.
  - After: the question, the stage, the three labelled numbers, and a PAPER badge if a position exists.
- **Expanded:** the forecast history with timestamps, then summaries of the Brief, Match, Price check and Paper position, each opening its own detail.
- **Secondary actions:** edit wording (before a forecast only; afterwards a new revision), revise forecast, archive, call card.

### 2. Forecast control

- A labelled slider with 5-point stops plus a number field. Both work by keyboard, and screen readers announce the value and its plain-language reading.
- An optional "range" toggle captures a low/high band.
- Committing stamps the time. Later changes create revisions, and the original stays visible.

### 3. Brief (research)

- **Biggest:** the balanced bottom line, then "what would change this".
- **Sections:** base rate (reference class, count, timeframe); case for; case against; facts versus inference; sources (title, publisher, date) with links.
- **Primary action:** Review sources.
- **Secondary actions:** challenge a point (sends it to chat), re-research.
- **Working state:** sections fill in as they complete. **Error state:** completed sections stay, and gaps are listed.

### 4. Contract match

- **Biggest:** the user's Question and the contract wording one above the other.
- **Rule fit:** three rows (Wording, Deadline, Resolution source), each ✓ matches or ✗ differs with one plain sentence, and a level badge: Exact, Close or Related. The full rules sit behind "Read the contract rules".
- **Primary action:** for Exact, **Use this contract**; for Close, **Forecast the contract's version**; Related contracts are shown as context only.
- **Secondary actions:** compare alternatives, mark "none of these fit".
- **Empty:** "No contract asks exactly this question." Saving and watching remain the primary action.
- A contract is never substituted silently. If its rules or status change, the card shows what changed.

### 5. Price check

- **Biggest:** the verdict: **Possible edge**, **No edge** or **Not enough evidence** (rules in [agent.md](agent.md#price-check-rules)). Exact matches only.
- **Below the verdict:**
  - the three labelled numbers;
  - the market after spread and fees for the chosen size;
  - the gap at your forecast and at Polymancer's, shown separately;
  - quote age.
- **Primary action:** Save and watch.
- **Secondary actions:** review assumptions (costs, depth); **Put it to work on paper**, only after Possible edge.
- "No edge" is neutral in tone and colour: a completed check, not a failure.

### 6. Paper position

- **Biggest:** maximum loss, then the thesis being recorded (the question and a one-line rationale).
- **Input order:** maximum loss first. Polymancer derives the shares and shows the entry price after costs and both outcomes in plain words ("If it resolves Yes: +$34 paper. If No: −$25 paper.").
- **Primary action:** Record paper position. It stays disabled until the match and price are fresh.
- Confirmation shows "Paper position recorded" with a short undo.
- Larger sizes get no added emphasis.

### 7. Watch alert

- **Biggest:** what changed, in one sentence.
- **Then:** what it means for the original reasoning, and the current three numbers.
- **Actions:** keep, revise forecast, close paper position, mute this Question.

### 8. Record

- **Biggest:** resolved count and running average scores (yours, Polymancer's, and the market's where an exact match existed), each with a sample size.
- **With enough history** (threshold in [system.md](system.md#scoring)): a calibration chart, for you and for Polymancer, with uncertainty bands.
- **Paper PnL:** shown second, separately.
- **Filters:** topic, period, resolved only.
- **Empty:** "Your record starts when your first question resolves," plus the next upcoming deadline.

## Build priority

For a solo developer:

1. Question card. A custom renderer: the console artifact renderer in M1; inline chat and the ChatGPT widget once the platform supports them.
2. Contract match.
3. Paper position.
4. Price check.
5. Brief.
6. Record.

Components 2–6 ship first as structured chat markdown and generic state views, then upgrade in that order.

## Accessibility

- Visible focus.
- Status is never carried by colour alone.
- Contrast of 4.5:1 for text.
- Touch targets of at least 44 px.
- Reduced motion respected.
- Every chart has a table equivalent.
- Probabilities are read with their plain-language form.
