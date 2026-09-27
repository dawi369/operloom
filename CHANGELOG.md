# Changelog

## Polymancer 1.0.0 (fork)

Local acceptance on 2026-09-27, `pnpm operloom dev` on macOS (Worker 8787,
signed runner 3101, console 3000, minute scheduler), local API auth with a fresh
user, real OpenRouter model:

- Health: Worker, runner and console `/api/health` return 200.
- Bootstrap: the workspace gets exactly one agent, Polymancer, with effect
  target `simulation`.
- Settings: strategy and `maxPositionUsd` saved (version 1) and pinned on every
  later run.
- Simulated order: `polymancer.copy.start` tracks the wallet; `copy.sync` with
  one fixture trade records one paper fill; the replay is a duplicate.
- Queries: `polymancer.portfolio` returns cash 990.70, exposure 9.30 and one
  position; `polymancer.operator-state` lists the copied activity.
- Chat: thread create and a turn complete over the session SSE stream; the
  model answers holdings and strategy from recorded evidence.
- Monitors: `heartbeat` and `wallet-activity` dispatched by the scheduler and
  completed; the wallet monitor reads live Polymarket activity; the heartbeat
  records a `noop` decision with its settings version and context snapshot.
- Found and fixed upstream: request-mode monitor ticks failed with
  `trigger_input_invalid`; one slow `ps` poll stopped the whole local stack.
- Gates: `pnpm verify:fast` and `pnpm test:e2e:local:release` (console,
  operations panel, chat lifecycle and accessibility audits) pass.

Not covered locally: WorkOS Google sign-in (the local stack uses local API auth,
which the console only allows under `NODE_ENV=development`), live market quotes
for the heartbeat, and live order placement (fails closed outside simulation).

## Unreleased

- Model-visible chat tools receive the typed state port for the agent's current
  effect target, so chat commands can record package state.
- `createPackTestRuntime` (`cloudflare/control-plane/src/pack-test-runtime.ts`)
  runs package acceptance tests on the real workflow, settings, query and state
  paths over in-memory SQLite, with one isolated workspace per test user.
- Fixed: request-mode schedule and monitor triggers failed every tick with
  `trigger_input_invalid` on strict workflow input schemas, because scheduler
  bookkeeping (`skippedOccurrences`) was merged into the workflow input.
- Fixed: one slow `ps` poll stopped the whole supervised local stack; the
  resource monitor now fails closed after five consecutive failures.
- Release and accessibility e2e specs read the title from `config/product.json`
  and stop before upstream-only packs when a fork changes the default pack.

## 2.0.0

Clean-slate baseline. There is no upgrade path from 1.x; rebuild databases from
the baseline schema.

- One Runtime Module contract (`defineControlPlaneModule`, `apiVersion: 2`) for
  `@operloom/agent-sdk` SDK 2.0.0. Packages declare `requirements` with
  unversioned capabilities (`workflow.request`, `state.atomic`,
  `state.migrations`, `context.snapshots`, `models.structured`,
  `usage.reservations`). The v1 module contract, its adapter and the workflow
  `engine` field are removed.
- `@operloom/client` and `@operloom/react` 2.0.0 drop the
  workflow `engine` field from run and workflow contracts.
- LangGraph is removed. The signed Node.js tool runner runs standalone from
  `runner/server.ts` (`pnpm start:runner`, `Dockerfile.runner`,
  `fly.runner.toml`).
- Public API, typed state, context, structured models, usage limits,
  simulations, durable workflows, package upgrades and provider operations are
  always on; their rollout flags are removed. Workspaces without an
  administrator budget receive default limits on first use.
- D1 history is squashed into `0001_baseline.sql`; recreate databases instead of upgrading.
- `/v1` is the only public control-plane API. Internal routes, facade signatures and caller-supplied identity headers are no longer accepted from the network.
- `/v1/me/<operation>` runs an operation against the caller's active workspace
  agent; `/v1/workspaces/{id}/agents/{id}/<operation>` targets one explicitly.
  The bundled console uses `/v1/me` with the signed-in WorkOS access token.
- Identities are renamed: `WORKBENCH_*` → `OPERLOOM_*`, `x-workbench-*` and
  `x-assistant-mk1-*` → `x-operloom-*`, `CLOUDFLARE_CONTROL_PLANE_URL` →
  `OPERLOOM_BACKEND_URL`, `CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN` →
  `OPERLOOM_LOCAL_API_TOKEN`, `@operloom/workbench-client` → `@operloom/client`,
  `@operloom/workbench-react` → `@operloom/react`, Durable Objects
  `ThreadChatAgent`/`SessionAgent`, and `operloom-*` resource names.
- Effect target (`simulation` | `external`) is an agent setting
  (`GET/PUT /agents/{id}/effect-target`, owner/admin, revision-fenced and
  audited). Every run pins its target; packages no longer declare
  `stateTarget`. Agents start in simulation.
- Actions have one path. Bindings may declare `simulate(proposal, context)`;
  agents in simulation run it instead of the provider, connection or runner,
  with identical results, approvals, receipts and projections. `actions.simulate`
  and simulation-only bindings are removed.
- Packages declare operator-editable `settings` (versioned per agent, pinned per
  run, `GET/PUT /agents/{id}/settings`, shown to chat as data) and read-only
  `queries` (`GET /queries`, `POST /queries/{id}`) for client read models.
- Monitors: triggered runs receive `context.run.trigger` (installed trigger,
  package trigger id, dispatch, source, occurrence, attempt). The SDK adds
  `observeMonitor`, `monitorFingerprint` and `monitorCursorState` for
  once-per-change decisions. Rendered hosted Workers tick every minute and
  `pnpm operloom dev` drives the scheduled handler locally.
- `config/product.json` `workspace.defaultAgentPack` selects the pack each new
  workspace's default agent is created from, and `workspace.maxAgents` caps
  active agents per workspace (`409 agent_limit_reached`). `fork init` accepts
  `--default-pack` and `--max-agents`.
- Webhook notifications: owners/admins subscribe HTTPS endpoints to
  control-plane event types (`GET/POST /webhooks`, `DELETE /webhooks/{id}`,
  `GET /webhooks/{id}/deliveries`, `POST .../deliveries/{id}/retry`). Deliveries
  are HMAC-signed, retried with backoff for 8 attempts, then marked `failed`.
- The console adds an Operations panel (`/operations`): effect target, package
  settings, decisions and effects, typed state records, package queries, action
  proposals and webhooks. It uses `@operloom/client` with `target: "me"`
  through a same-origin `/api/v1/me` bridge that forwards only allowlisted
  operations with the server-side session token. OpenAPI publishes every
  operation under both `/v1/workspaces/{id}/agents/{id}` and `/v1/me`.
- `examples/resource-allocator` is the reference operator loop: minute monitor
  over a mock capacity feed, `noop`/escalate, a structured model decision,
  reserved allocation proposals under operator approval, simulator or reviewed
  provider operation, and a ledger projection with derived pool state and
  queries. Runtime conformance proves the loop and that replay changes nothing.
- The local model fixture now satisfies any structured output schema (schema
  `default`, then `const`, first `enum` value, or a minimal typed value).
