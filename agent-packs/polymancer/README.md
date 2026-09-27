# Polymancer package

Paper-trades Polymarket by copying tracked wallets under the user's strategy and
risk limits. It is the product's default agent (`config/product.json`), one per
workspace. Everything runs on the Operloom Runtime Module contract; there are no
core edits.

| Surface   | What it does                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------ |
| Settings  | `strategyPrompt`, `maxPositionUsd`, `maxOpenPositions`, heartbeat `priceMoveAbs` and `exposureMovePct` |
| Chat      | Grounded in the `polymancer.portfolio` context; `start copy trading 0x…` calls `polymancer.copy.start` |
| Workflows | `polymancer.copy.start`, `polymancer.copy.sync`, `polymancer.heartbeat`                                |
| Monitors  | `wallet-activity` and `heartbeat`, once a minute (enable them per agent)                               |
| Queries   | `polymancer.portfolio`, `polymancer.operator-state`                                                    |
| Events    | `copy_trading.started`, `paper.fill`, `heartbeat.material` (deliverable through webhooks)              |

`copy.sync` reads `https://data-api.polymarket.com/activity` for each active
wallet (or an `activity` fixture input), mirrors each new TRADE once and commits
the activity record, the fill ledger entry, the position and paper cash together.
Replayed events are duplicates. Paper cash starts at 1000 USD; fills use the
source trade price, and average entry follows the original backend's formula.

`heartbeat` marks positions to supplied `markets` quotes (or the last known marks)
and records a `noop` or `material` decision. Live market quotes are not fetched
yet.

Paper execution runs only when the agent's effect target is `simulation`. Under
`external` the workflows fail closed with `live_trading_unavailable`; no live
order binding exists.

`domain.ts` holds the pure fill, risk, heartbeat and copy-translation logic.
`domain.test.ts` ports the original backend's expected values;
`acceptance.test.ts` runs the full loop on `createPackTestRuntime`.
