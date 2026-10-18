# Changelog

## Unreleased

- Memory policy (W12.1): the manifest `memory` block lets a pack choose which
  model and workflow writes activate without a tap (`autoActivate`), how long
  agent claims live (`ttlDays`) and what shape their content must have
  (`contentSchema`); packs with `risk.financialData` propose everything by
  default. Records gain `target`, `expiresAt`, `scope: "workspace"` (owner and
  admin writes shared with the workspace) and content `flags`; secrets and card
  numbers are refused on write. The prompt now separates "what the user told
  you" from dated agent claims and marks stale ones; recalled record ids are
  pinned into the context snapshot; expired records are archived on the tick;
  a proposal pushes a `memory.proposed` notification. Console gains `/watch
<name>`; mobile gains a Memory tab; `baby-polymancer` steers research from
  the watchlist and remembers dated conclusions. Migration 0008.
- Admin memory: owners and admins get a Memory tab in the admin panel (and
  `client.admin.memory.*` over `/v1/me/admin/memory`) listing every member's
  records with status, kind, member and text filters, the active agent's
  effective policy, inline edit of title, content, kind and expiry, and
  confirm, archive or restore. Edits are guarded and audited as
  `memory.admin_edited`.
- Admin panel: tabs are now Approvals (with the pending badge), Tools, Agents,
  Memory, Audit and Diagnostics, plus a Members shortcut into the workspace
  panel. The Audit tab (`GET /v1/me/admin/events`, `client.admin.events.list`)
  is a workspace-wide feed of control-plane events with actor, type-prefix and
  text filters and cursor paging. The Memory tab shows per-member usage against
  quotas and offers two bulk actions, archive stale proposals and forget
  everything about a target, over `POST /v1/me/admin/memory/bulk-archive`
  (audited as `memory.admin_bulk_archived`).
- Memory and context (W12): durable per-user memory records (`goal`,
  `preference`, `watchlist`, `conclusion`, `note`) scoped user-wide or to one
  agent, with `proposed`/`active`/`archived` status. Users write through
  `PUT /workbench/memory/{kind}/{key}`, confirm proposals and forget records;
  packs that require `memory.recall` get `context.memory` in workflows; chat
  exposes a `memory.remember` tool whose goal and preference writes stay
  proposed until confirmed. Every chat turn now starts with a recall section,
  the last five artifact summaries and the context snapshot grouped by trust,
  and long transcripts are budgeted to 48,000 chars with a digest of what was
  dropped. Migration 0007; console gets a `/memory` panel.
- Billing: Polar ships as a second provider module (merchant of record):
  checkout, customer portal, Standard Webhooks verification and usage event
  ingestion; `OPERLOOM_BILLING_PROVIDER=polar`. Migration 0006 widens the
  subscription provider set.
- MCP adapter (W7): `POST /v1/me/mcp` serves the active agent's user-invocable
  workflows and queries as MCP tools over stateless Streamable HTTP, behind the
  WorkOS bearer and `OPERLOOM_MCP_ALLOWED_CLIENT_IDS`; results carry the pack's
  renderer kind in `_meta`, and `/.well-known/oauth-protected-resource`
  publishes the authorization server for ChatGPT and Claude connectors.
- Mobile push: `apps/mobile` registers the install with `/workbench/devices`
  after sign-in, revokes it on sign-out and routes notification taps to the
  approvals or chat tab.
- Daily usage reports now run on the scheduler tick for every workspace that
  used resources the previous day (idempotent per workspace and day).
- CI: one fast `verify:fast` job per push; browser conformance, Docker and the
  production build moved to `release-gates.yml` (manual or nightly). The SDK
  consumer check uses `--prefer-offline` so a cold pnpm cache no longer fails
  it. Removed six unused `@radix-ui/*` packages.
- Cleanup: removed orphaned modules the runtime v2 and series work made dead
  (the pre-Durable-Object `cloudflare-chat-runtime`, the console tool registry,
  the mobile access-token shim, two unused workbench components and two
  unreferenced smoke scripts), fixed lint warnings, pruned merged local
  branches and stale worktrees, and refreshed the docs map.
- Mobile shell: `@operloom/client` gains `target: "control-plane"`, mapping
  every console operation onto the Worker's `/v1/me` routes through one table
  (`route-map.ts`, proven against the public API allowlist and exercised in
  the agent-system e2e). `apps/mobile` is a lean Expo app on that client:
  WorkOS AuthKit PKCE sign-in with secure session storage, chat over
  `createFetchChatTransport`, an approvals inbox and workspace/agent switching.
  No push, offline cache or store configuration yet.
- Billing and entitlements: `config/billing.json` declares plans as a budget
  ceiling plus a feature set; `PUT /workbench/budgets` rejects limits above the
  plan (`budget_exceeds_plan`), bootstrap clamps to it and a plan change clamps
  the stored policy in the same batch. Delegation and relay notification
  channels require their plan feature. `/workbench/billing/*` exposes the plan,
  catalog, manual assignment, Stripe checkout and portal links, daily usage and
  idempotent usage reports (`client.billing.*`); `/workspace-context` and
  packs declaring `entitlements.read` see the resolved entitlements. The Stripe
  module uses raw `fetch` and verifies `Stripe-Signature`; it is unit-tested
  against fixed vectors and not yet exercised against a live account
  (migration 0005).
- Runner recipes: `runner.ts` tools receive `context.recipes` with bounded
  `process`, `browser`, `repository`, `document` and `artifact.upload` building
  blocks plus `usage()`. Every recipe clamps its timeout and byte cap to
  `recipeLimits`, charges a per-call 8 MiB budget, redacts secret-looking
  output, honours the tool's signed network allowlist, and the browser recipe
  degrades from Playwright to a plain fetch engine when no browser is installed
  (`runner/recipes.ts`). `repo.snapshot` now runs on the repository recipe and
  the `complex-operator` example gained `operator.page.read`; the agent-system
  conformance journey scrapes a runner-served fixture page through it and
  proves an off-allowlist host fails the run.
- Bundled provider adapters in `@operloom/agent-sdk/providers`: calendar read
  and create (Google Calendar, Microsoft Graph), mailbox read and send (Gmail,
  Microsoft Graph), geocoding (Nominatim-shaped), routing (OSRM-shaped), news
  search (NewsAPI-shaped) and a transactional email provider operation. Each is
  a pure request builder and response normalizer; the tool factories
  (`calendarReadTool`, `mailboxReadTool`, `geocodeTool`, `routeTool`,
  `newsSearchTool`) call the brokered connection with
  `broker://configured/<path>`, which the broker joins onto the provider's
  configured endpoint so packages never name hosts. A tool with a `recorded`
  sample returns it, marked `source: "recorded"`, while its connection is not
  authorized. `examples/service-desk` binds calendar read and transactional
  send; broker unit tests cover OAuth refresh (lease, token rotation, failure
  to `refresh_required`) and revocation for one provider.

- Agent delegation: a run hands a bounded workflow to another agent in the
  workspace through `context.tasks.delegate({ agentId, workflowType, input,
deadlineMs, idempotencyKey })` (capability `tasks.delegate`) and reads the
  outcome later with `context.tasks.result(taskId)`. Tasks live in
  `control_delegation_tasks` (migration `0004`); the scheduler tick leases
  queued tasks and runs them as the target agent with
  `context.run.delegation` set, expiring tasks past their deadline. The target
  must be active in the same workspace and the workflow user-invocable or
  `delegable`; `resourceLimits.maxDelegationDepth` (default 2) and
  `maxDelegationFanOut` (default 4) bound chains; a replayed key returns the
  same task and changed content conflicts. Cancelling the parent cancels its
  queued children. The parent's history snapshot lists `delegations` and the
  delegated runs as `childRuns`. Budgets stay with the child run (the parent
  may already have finished); `delegation.rootRunId` records lineage.
  `examples/document-review` gains a `delegate` workflow.

- Packages render their own chat and history cards. A manifest declares
  `artifactRenderers[].renderer: "module"` (optionally `maxBytes`) and
  `toolResultRenderers: [{ toolId, version, maxBytes? }]`; the web module
  supplies the React components under `artifactRenderers` and
  `toolResultRenderers`. The console registers each compiled tool renderer
  with assistant-ui so the model's tool calls render inline, and History uses
  the same lookup for artifacts. Components receive sanitized message data
  only (`ToolResultRendererProps`: tool id, status, input, output, artifact
  refs); payloads past the bound (default 64 KiB) and renderer exceptions fall
  back to the generic JSON view. The compiler refuses undeclared, duplicate or
  mismatched renderers. `examples/document-review` ships a report card.

- Notification channels: deliveries carry a channel (`push`, `email`, `sms`)
  on one ledger with a dedupe key, per-channel and per-event-type preferences
  with UTC quiet hours and a digest hour (`GET/PUT
/workbench/notifications/preferences`), a stored email override or SMS number
  in the vault (`PUT /workbench/notifications/address`), and a delivery list
  (`GET /workbench/notifications/deliveries`). Packages declare
  `notifications: [{ type, description, defaultChannels }]` and emit through
  `context.notifications.emit` (capability `notifications.emit`); each event
  is a control-plane event. `info` events fold into one digest per channel on
  the scheduled tick, `action` waits out quiet hours, `alert` goes at once.
  Email and SMS leave through a signed platform relay
  (`OPERLOOM_NOTIFICATION_RELAY_URL` / `_SECRET`); without one, and in E2E
  mode, a recorded transport marks the row delivered. Hosts without a queue
  binding drain due deliveries from the scheduled sweep. Push behaviour and the
  device routes are unchanged. Migration `0003` rebuilds the deliveries table.

- Actions can declare `approval: "policy_controlled"` with
  `policy.limits` (`count` per hour or day, `amount` of a preview field per
  period, `allowlist` of a preview field against an agent setting) and
  require `actions.policy_controlled`. `context.actions.propose` evaluates
  the limits, records the decision and evidence on the proposal, and when every
  limit holds admits and dispatches the action in the same call, returning the
  dispatch status with `approval: "auto"`; otherwise it returns `proposed`
  with `approval: "review"` and the operator path is unchanged. Dispatch
  re-checks preflight, policy, kill switches and current settings, downgrading
  to review on any refusal. Auto dispatches appear in
  `GET /workbench/actions?review=pending` until an owner or admin acknowledges
  them with `POST /workbench/actions/{id}/review`; the resource-allocator
  example allows one unattended allocation a day.

- Provider operations are declared by the package instead of a closed platform
  list. A control-plane module lists `providerOperations` (id, version,
  `providerId`, `bearer` or `hmac-sha256` auth, method, endpoint path suffix,
  input and output schemas, timeout, response byte limit and the receipt
  field mapping) and requires `actions.provider_operations`; a tool's
  `action.providerOperation` must reference one of them, and its connection
  must name the same provider with an `api_key` credential. The environment
  still binds `providerId` to a configured connection provider, the response
  projection is the output schema's property allowlist, and HMAC requests sign
  with `x-operloom-timestamp` and `x-operloom-signature`. The compiler rejects
  undeclared references, duplicate declarations, open output schemas and
  receipt fields missing from the output.

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
