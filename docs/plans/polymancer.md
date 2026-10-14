# Plan: Polymancer on Operloom

Polymancer is a private fork (`~/dev/polymancer`, `upstream` = Operloom,
fetch-only). Its product spec is `agent-packs/polymancer/docs/` in that fork;
this plan lists the Operloom work it needs and the order, by capability id
from [capabilities](../capabilities.md).

## Where it stands

- M1 (idea loop on paper) is built in the fork on recorded fixtures and passes
  every Operloom conformance suite. It uses C1–C7, C10–C12, C14–C17, C19,
  C20, C22 (simulation only), C28, C29.
- Exit still open: a live session against Kalshi locally and Polymarket from a
  deployed Worker with a real model and `EXA_API_KEY`.
- No platform work is needed to finish M1. The pack declares no runner tools
  yet; every venue read fits a Worker fetch.

## Platform work, in order

| Step      | Workstream                             | Why Polymancer needs it                                                                                                                              | Milestone  |
| --------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1         | W3 Notification channels (email first) | Watch alerts and the weekly digest arrive outside the app.                                                                                           | M2         |
| 2         | W6 Pack chat renderers                 | The Question card inline in chat.                                                                                                                    | M2         |
| 3         | W7 MCP adapter                         | ChatGPT app with research and paper scope; widgets reuse the card.                                                                                   | M2         |
| 4         | W10 Mobile shell; W3 push              | Mobile at web parity with push alerts.                                                                                                               | M3         |
| 5         | W8 Billing and entitlements            | Free and Plus, research allowances, pay-per-use deep research.                                                                                       | M3         |
| 6         | W1 Open provider operations            | `polymarket.order.place` as a declared effect with a receipt and a paper simulator.                                                                  | Later      |
| 7         | W2 `policy_controlled` approvals       | Per-trade approval today; limit-bound auto-execution for power users later.                                                                          | Later      |
| 8         | W9 Financial custody and signing       | Session keys and API keys in Vault; signing in runner or broker. After the legal read.                                                               | Later      |
| as needed | W11 Runner recipes                     | Deep research over long documents, venue pages without an API, and order signing run in `runner.ts` through the signed runner, not in platform code. | M3 / Later |

W5 (delegation) is optional for Polymancer. Research, risk and execution can
stay one agent with separate workflows; adopt delegation only if the roles
need separate prompts, budgets or approval posture.

## Fork work per milestone

- **M1 exit:** live venue session, `EXA_API_KEY` in `.dev.vars`, deployed
  Worker for Polymarket reads, data-use permission before public launch.
- **M2:** notification events from `watch.tick` (alert, digest), Question card
  renderer in `web.ts`, topics onboarding, call cards, MCP allowlist and app
  submission.
- **M3:** entitlement checks in `brief.create` and deep research; mobile
  parity; builder-program applications.
- **Later:** `polymarket.order.place` provider operation declared in
  `control-plane.ts` with `simulate`, its signing step in `runner.ts`; the `external` effect target stops
  failing closed only when W9 is complete and the legal read is done.

## Decisions to take

- Alert transport for the "wallet moved" fast path: the external alerter posts
  to a per-trigger webhook (C12). No streaming collector on the platform.
- Whether to split research/risk/execution into agents (W5 task records) or
  keep one agent. Default: one agent until a role needs its own approval
  posture.
- Live trading (W9) waits until paper trading is proven; nothing is built for
  it before then.

## Gates

Every merge down from upstream: `pnpm -s verify:fast`,
`pnpm conformance:runtime` for runtime or UI changes, and
`pnpm test:e2e:local:release` before a release.
