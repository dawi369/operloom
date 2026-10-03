# Changelog

## Unreleased

- `context.models.structured({ includeContext: false })` keeps the run's
  context snapshot out of the call, so a judgment can rest only on the evidence
  in its prompt.

- Model-visible package tools receive `context.models` and `context.search`
  when the package declares `models.structured` or `search.web`, metered on the
  tool's run like workflow calls.

- Workflows can search the web through `context.search.web` (capability
  `search.web`): Exa-backed, dated results with publish-window filtering,
  metered and replayed as tool usage. The key stays in the Worker
  (`EXA_API_KEY`); local E2E mode and `createPackTestRuntime` return a fixture.
- Packages can install their own declared schedule or monitor triggers through
  `context.triggers.ensure(id)` (capability `triggers.ensure`), for workflows
  and model-visible tools. Owner/admin only; installed triggers are left as
  they are. `createPackTestRuntime` and `agent-packs:test` provide the port.
- Forks can hide the bundled demo packs by marking them `conformanceOnly`;
  platform unit tests read fixtures from the compiled registry and skip cases
  that need a demo pack installed.
- Forks whose default pack is not `operloom` skip the Level 2 and Level 3
  browser journeys, which drive upstream demo packs. `agent-packs:test`
  generates tool inputs from a schema's `examples` after `default` and `enum`,
  so pattern-constrained inputs validate. Standalone tools of packages that
  need runtime ports receive the in-memory runtime's typed-state port.
- Security: `next` 16.3.6 (GHSA-vcvr-r3jv-pc5j, critical) and overrides for
  `undici` 7.29.1, `fast-uri` 3.1.7 and `brace-expansion` 5.0.11 clear the
  high advisories that blocked `verify:security`.
- Chat stack on AI SDK 7 (`ai` 7, `@openrouter/ai-sdk-provider` 3), `agents`
  0.24, `@cloudflare/ai-chat` 0.12 and assistant-ui 0.15; verified by
  `verify:fast`, `conformance:runtime` and the local release browser suite.
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
- Fixed: `POST /agents/{id}/activate` left chat on the previous agent; it now
  moves the session coordinator to the activated agent on a new thread.
- Fixed: `/v1` returned 500 instead of 423 `workspace_export_in_progress` for
  writes during an export, and overwrote `private, no-store` with `no-store`.
- `pnpm agent-packs:test` runs workflows of packages that need state, context or
  model ports on the in-memory control plane and skips direct execution of
  provider-operation tools; `document-review` and `resource-allocator` declare
  their managed-state renderers.
- The agent-system conformance journey opts its agent into `external` and
  asserts that a pack kill switch blocks new runs and cancels pending proposals.
- Docs describe the v2 topology (Worker `/v1`, console as a `/v1` client, signed
  runner on Fly) instead of LangGraph and the signed Next facade, and drop removed
  feature flags and hosted-evidence scripts. `pnpm docs:check` now rejects any
  documented `pnpm` script that does not exist.

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
