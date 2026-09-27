# Operloom reset: the generic base that Polymancer forks from

Supersedes `plan-v1-compat` (same directory), which preserved compatibility for
users that do not exist. Its milestone 1–7 work is kept as the starting point;
its compatibility constraints are dropped.

## Decisions (confirmed 2026-09-27)

- No users, no retained data. Every change may be breaking. No backups, no data
  migrations, hosted D1 databases are wiped and re-provisioned.
- Main stays product-neutral. Polymancer is a private fork created through the
  fork playbook; gaps found there go upstream as generic changes.
- `baby-polymancer` and `baby-swordfish` stay in main as demos of Operloom's reach.
  The Polymancer fork replaces `baby-polymancer` with the real package.
- WorkOS is the only identity provider. Supabase is not carried into the fork.
- Keep: Cloudflare control plane (D1, Durable Objects, Workflows), Next.js web
  console, vault/credential broker, and the signed Node runner as a core part
  of the product.
- Remove: LangGraph. Today it is a one-node starter graph that no pack uses; it
  is co-hosted with the runner, so removal means extracting the runner, not
  deleting the Fly service.
- Rename `workbench` identities to `operloom` (env vars, signed headers, client
  packages, Fly/Cloudflare resource names).
- Live trading is out. Prove the generic signed-operation/credential path with a
  non-financial provider only.
- Monitors are minute-scale scheduled triggers. No persistent collectors.
- Finish line: local end-to-end paper loop in the Polymancer fork plus one hosted
  staging deploy and smoke. 24h soak, restore drill and production claims are
  deferred.

## Phase 0 — Checkpoint

1. `pnpm verify:fast` under the supervisor on the current dirty tree; fix failures.
2. Commit the tree as one checkpoint on `checkpoint/runtime-v2`; tag `pre-reset`.
3. Branch `reset/baseline` from it. Main fast-forwards when phase 1 passes.

**Gate:** verify:fast green at the tagged commit.

## Phase 1 — Reset (destructive)

One concern per commit, typecheck + unit tests green after each.

1. **One runtime contract.** Module v2 becomes the only contract with no version
   suffix (`defineControlPlaneModule`). Delete v1, `adaptControlPlaneModule`,
   v1 fixtures/snapshots and v1 consumer tests. Keep capability negotiation
   (`requirements.capabilities`, `minimumBackendVersion`): forks merge upstream
   and need an actionable incompatibility error. Bump SDK/client to 2.0.0.
2. **Squash migrations.** Replace `0001`–`0033` with `0001_baseline.sql` built
   from the final schema; `schema.sql` and the baseline must match (keep the
   parity check). Forward-only migrations resume after the baseline. Delete the
   historical-parity/upgrade migration tests that only exist for history.
3. **Delete rollout flags.** Remove every `*_ENABLED` capability gate (typed
   state, context, structured models, usage limits, simulations, provider
   operations, durable workflows, public API, package upgrades). Keep
   operational kill switches (workspace, agent, tool, provider, triggers).
4. **Remove LangGraph; extract the runner.**
   - Delete `backend/agent.ts`, `langgraph.json`, `@langchain/*` deps,
     `engine: "langgraph"`, the LangGraph proxy route in `app/api/[..._path]`,
     `start:backend`/`dev:backend`, and the langgraphjs child process.
   - `scripts/langgraph-runtime-gateway.ts` → `runner/server.ts` (signed tool
     execution only). `Dockerfile.langgraph` → `Dockerfile.runner`,
     `fly.langgraph.toml` → `fly.runner.toml` (app `operloom-runner`).
   - The runner is part of the default dev supervisor and deployment runbook.
     Packs without runner tools still execute when the runner is down; runner
     tools report unavailable instead of failing the run.
5. **Web console becomes a plain client.** The Next.js app calls `/v1` through
   the Fetch client with a WorkOS access token. Delete the cookie facade,
   signed Next→Worker facade routes, and any web-only authorization path.
   Next.js keeps only AuthKit session handling and token hand-off.
6. **Renames.** `WORKBENCH_*` → `OPERLOOM_*`; `x-workbench-*` → `x-operloom-*`;
   `@operloom/workbench-client` → `@operloom/client`;
   `@operloom/workbench-react` → `@operloom/react`; resource names
   `assistant-mk1-*`/`workbench-*` → `operloom-*`. Update `.env.example`,
   environment configs, and the release-identity check. Remove the AGENTS.md
   rule that protected old signed identities.
7. **Prune.**
   - Docs: 68 → about 12: README, getting-started, architecture, package
     authoring (contract + patterns), headless API, operator console, runner,
     forking, deployment, security, operations, changelog. Delete
     `runtime-delivery-status.md`, `advisor-plans/`, `plans/`, and
     reference-app/pre-1.0 docs. Record verified status in the changelog only.
   - Scripts: 135 → about 25. Merge the `smoke:cloudflare-*` family into one
     backend conformance suite and `acceptance:hosted:*` into one hosted suite.
     Delete release-evidence ledgers and scripts that exist only for them.
   - Delete stale `codex/*` branches only after confirmation.
8. **Wipe and re-provision.** Rebuild local D1 from the baseline. Delete and
   recreate hosted demo/staging Workers, D1, R2 and Fly apps under the new names.

**Gate:** typecheck, lint, unit tests, backend-only conformance, runner signed-tool
test, web console chat journey against `/v1` with a real WorkOS login (Google).

## Phase 2 — Generic features that Polymancer-shaped apps need

Each item is framed and tested generically. The Polymancer mapping is noted
for traceability only; no trading vocabulary enters core.

| #   | Capability                         | Polymancer need                            | Current state                                                                      |
| --- | ---------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| 1   | Effect target as agent setting     | paper/live switch hidden from the agent    | `stateTarget` chosen in package code                                               |
| 2   | Operation simulators               | paper fills with real-looking results      | simulation scope exists, no simulator contract                                     |
| 3   | Monitors with cursors              | heartbeat, wallet activity sync            | durable triggers + dedupe exist, no per-trigger cursor or observe/escalate pattern |
| 4   | Package settings                   | editable strategy prompt                   | agent runtime config exists, not schema-declared or pinned                         |
| 5   | Package queries                    | portfolio, positions, operator state reads | typed state `get`/`list` only                                                      |
| 6   | Ledger pattern                     | fills → positions                          | atomic commit exists; document + test pattern                                      |
| 7   | Personal workspace + default agent | one bot per user                           | manual workspace/agent provisioning                                                |
| 8   | Notification delivery              | Telegram/app alerts                        | partial; no durable delivery state                                                 |
| 9   | Signed provider operations         | future CLOB orders                         | bearer/HMAC broker locally proven                                                  |

1. **Effect target is an agent-instance setting.** Operators choose
   `simulation` or `external` per agent through the API. Tool schemas, prompts,
   context and results are identical under both, so the model cannot tell them
   apart. Switching target requires an admin command, is audited, and pins into
   each decision. Simulation and external state never share a scope.
2. **Operation simulators.** A provider operation may declare a package-supplied
   simulator with the same input/output schema. Under `simulation`, the runtime
   routes to the simulator and commits its result with the same receipt, ledger
   and projection path as a broker result. The simulator can read authorized
   evidence (for example, current prices) but has no network credentials.
3. **Monitors.** A trigger declares `schedule` (minute granularity), a typed
   cursor, and an `observe` step that runs without a model call and returns
   `noop` or `escalate` plus evidence. Observed external events carry a package
   event key; the runtime deduplicates them per agent and coalesces overlapping
   ticks. `noop` records a cheap decision entry; `escalate` starts a durable run
   linked to the observation. Cursor advance commits atomically with the
   observation.
4. **Package settings.** The package declares a settings schema with defaults and
   which fields users may edit. Settings are versioned, editable via
   `/v1` and the console, injected into context, and pinned into every decision.
5. **Package queries.** The package declares read-only query handlers over its
   typed state and context (paginated, schema-validated output). Queries are
   exposed as `/v1/agents/{id}/queries/{name}` and in the client with generated
   types. No package touches core routes.
6. **Ledger pattern.** Document and test: append-only entries plus derived
   records updated in the same commit, keyed by an effect identity so replay
   cannot double-apply, queryable by declared indexes.
7. **Personal workspace provisioning.** A product setting auto-creates a personal
   workspace and one default agent from a configured package on first login,
   and can cap agents per workspace to one.
8. **Notifications.** Delivery through provider operations with durable delivery
   identity, bounded retry, dedupe and an operator-visible failed state.
9. **Signed operations.** Finish the broker path: domain reservations, state
   projection, and observation of pending external resources. Prove it with a
   non-financial signed-request provider and a disposable hosted resource.

**Gate:** conformance tests for each capability through the external-package
path, and a backend-only journey with no Next.js and no model calls, except
one opt-in model check.

## Phase 3 — Operator console and headless contract

- Console views for State, Decisions (with evidence and linked effects),
  Automations (monitors, next tick, cursor, pause/resume), Actions (receipts,
  reconciliation), Settings, and package query panels rendered from
  presentation descriptors. All views use `@operloom/client` only.
- Complete OpenAPI generated from shared schemas; idempotency keys on every
  command; cursor pagination everywhere; standard error envelope.
- SSE plus polling fallback for runs, decisions, approvals and notifications,
  with cursor-expiry reset.

**Gate:** a plain Node consumer and the console observe identical outcomes for
the phase 4 journey; desktop and mobile-width browser tests pass.

## Phase 4 — Neutral reference app in main

Expand `examples/complex-operator` into a resource-allocation app with the
same loop shape as Polymancer and a mock provider:

settings prompt → minute monitor with cursor over a mock capacity feed → `noop`
or `escalate` → structured model decision with evidence → proposed allocation →
approval or auto policy → simulator (or signed mock provider under `external`)
→ ledger + derived allocations → package queries → notification.

Keep `document-review` as the second, smaller proof. Scaffolding
(`pnpm operloom pack create`) produces this layout: schemas, settings,
monitors, queries, workflows, context resolvers, operations + simulators, tests.

**Gate:** a freshly scaffolded external package implements the loop with one
registry entry and no core edits; replaying observations changes nothing.

## Phase 5 — Fork playbook and Polymancer fork

1. Rewrite `docs/forking.md` for the new baseline; tag it `v2.0.0`.
2. Create the private `polymancer` repo with `pnpm operloom fork init`.
3. Port the domain logic from `~/dev/polymancer/apps/backend/src` as the real
   package, replacing `baby-polymancer` in the fork:
   - Settings: strategy prompt, risk defaults (max position, max open positions).
   - State: positions, fills (ledger), tracked wallets, market snapshots,
     wallet activity.
   - Monitors: heartbeat (price move ≥ 0.05, exposure move ≥ 10%) and wallet
     activity sync keyed on the activity event key.
   - Workflows: review/decide (structured decision contract), copy-trade
     translate, deep research (Polyseer-style, durable, network-policy bound).
   - Operations: `polymarket.order.place` with a paper simulator
     (fill math and average entry price); no live broker binding.
   - Chat tools: strategy/holdings/next-step questions, `start copy trading 0x…`.
   - Queries: operator state, portfolio with marks, decisions, activity feed.
4. Every gap becomes a generic upstream PR on main, merged into the fork through
   the documented update flow.

**Gate:** the retired checkpoint's acceptance criteria pass in the fork: save
strategy, grounded replies, start copy trading, fixture wallet trade → paper
fill → position, heartbeat noop/material, decisions and activity visible through
queries. Two users stay isolated. Replay changes nothing.

## Phase 6 — Staging

Deploy the fork's backend, runner and console to one staging environment with
provider operations limited to simulation. Smoke: health, WorkOS Google login,
thread create/stream, monitor tick, simulated order, queries. Record results in
the changelog.

## Verification per change

Narrowest check first (single test), then typecheck, lint, unit tests,
backend-only conformance. Browser tests and Docker builds run sequentially under
the supervisor, never together.

## Out of scope

Expo client, live Polymarket execution, wallet custody, marketplace or remote
package install, persistent event collectors, 24h soak, restore rehearsal.
