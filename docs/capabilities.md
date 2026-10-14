# Native platform capabilities

Operloom main must carry, natively and product-neutrally, every capability
that the products built on it need. A fork adds a package and configuration;
it never adds platform code, and it ignores the native capabilities it does
not use. Unused capabilities cost a fork nothing because each is inert until a
package declares it, an operator enables it, or an environment configures it.

Two driver products define the target set. Neither name belongs in platform
code (the `baby-polymancer` demo is the only exception); they appear here only
to trace requirements.

- **P — Polymancer.** A prediction-market notebook: ideas become dated
  Questions, matched to Polymarket and Kalshi contracts, researched with dated
  web evidence, price-checked against the live book, paper-traded, watched by
  minute monitors, resolved and scored. Later: alerts by email and push, a
  ChatGPT app, mobile, billing, and live orders approved per trade with
  custodied session keys. Reaction is minute-scale; an external alerter posts
  wallet moves to a webhook when faster is needed. Full spec lives in the fork
  (`agent-packs/polymancer/docs/`).
- **R — Roofing operator.** Several agents running a service business
  autonomously in one workspace: lead intake and client follow-up over email
  and calendar, a storm/news watcher, a territory scout over maps and public
  records, job and client records, with approval posture configurable per
  action type (auto within limits, human otherwise).

## Execution escape hatch

Cloudflare owns orchestration, policy, state and audit, but Workers cannot
run binaries, keep a filesystem, drive a headless browser or hold CPU for
minutes. The signed Node.js runner on Fly exists for exactly that work and is
a native part of the platform, not an add-on: every package carries a
`runner.ts` beside `control-plane.ts` and `web.ts`, declares runner tools with
`transport: "fly"`, and the compiler registers them with the same schemas,
policy, budgets and receipts as inline tools. A workflow step that needs heavy
work dispatches to the runner under a signed envelope and the result returns
through a signed callback; the step is still a Cloudflare step, so approvals,
cancellation, retries and history do not change. The runner never holds
tenant state or credentials beyond the envelope of one call. Packages without
runner tools run while the runner is down; runner tools then report
unavailable instead of failing the run. Products use it freely for scraping,
browser automation, repository or document processing, signing and any other
work outside Worker limits, and ignore it otherwise.

Status legend: **Done** is verified on main; **Partial** exists with a gap
named in the row; **Missing** has no implementation; **Later** is intentionally
deferred.

## Catalog

### Foundation

| Id  | Capability                                                                                | Status | P   | R   | Notes                                                                                   |
| --- | ----------------------------------------------------------------------------------------- | ------ | --- | --- | --------------------------------------------------------------------------------------- |
| C1  | Identity, tenancy, membership, policy, tool exposure, kill switches                       | Done   | x   | x   | WorkOS at the web boundary, Worker verifies tokens, every durable read/write scoped.    |
| C2  | Typed state, immutable decisions/effects, ledger, receipts, migrations, settings, queries | Done   | x   | x   | `/v1` state entries API; owner/admin versioned settings; read-only queries for clients. |
| C3  | Budgets and metering (model/tool reservations, workspace and root-run policy)             | Done   | x   | x   | Billing and entitlements are C32.                                                       |
| C4  | Audit, traces, runtime summaries, Sentry downstream                                       | Done   | x   | x   |                                                                                         |

### Agents and conversation

| Id  | Capability                                                                       | Status  | P   | R   | Notes                                                                           |
| --- | -------------------------------------------------------------------------------- | ------- | --- | --- | ------------------------------------------------------------------------------- |
| C5  | Chat on per-thread Durable Objects, assistant-ui console                         | Done    | x   | x   |                                                                                 |
| C6  | Several pack-backed agents per workspace, immutable snapshots, explicit upgrades | Done    | x   | x   | `workspace.maxAgents` caps; one default pack.                                   |
| C7  | User-driven agent switching with handoff summary                                 | Done    |     | x   | `session-agent-handoff.ts`; the user changes agent, context carries over.       |
| C8  | Agent-to-agent delegation (a run hands bounded work to another agent)            | Missing | x   | x   | Today agents coordinate only through shared managed state and triggers. See W5. |
| C9  | Inline tool-result renderers in chat (pack-owned cards)                          | Missing | x   | x   | Pack `web.ts` registers artifact renderers, not chat parts. See W6.             |
| C10 | Artifact renderers                                                               | Partial | x   | x   | `json` renderer; rich renderers arrive with W6.                                 |

### Autonomy

| Id  | Capability                                                                                          | Status | P   | R   | Notes                                                                  |
| --- | --------------------------------------------------------------------------------------------------- | ------ | --- | --- | ---------------------------------------------------------------------- |
| C11 | Schedules and monitors on a leased minute tick, `observeMonitor` cursors, `context.triggers.ensure` | Done   | x   | x   | 60 s floor by design.                                                  |
| C12 | External signal ingress: per-trigger webhooks with hashed secrets, idempotency                      | Done   | x   | x   | Covers "an alerter saw a wallet move" and "a lead form was submitted". |
| C13 | Streaming or long-lived collectors                                                                  | Later  |     |     | Not a platform goal; external alerters post to C12.                    |
| C14 | Durable workflows: steps, timer waits, `202` submission, recovery                                   | Done   | x   | x   |                                                                        |

### Knowledge and read access

| Id  | Capability                                                                                | Status  | P   | R   | Notes                                               |
| --- | ----------------------------------------------------------------------------------------- | ------- | --- | --- | --------------------------------------------------- |
| C15 | Web search port with dated results and cutoffs, server-held key                           | Done    | x   | x   |                                                     |
| C16 | Context resolvers with trust levels and evidence linkage                                  | Done    | x   | x   |                                                     |
| C17 | Connection broker: OAuth code + PKCE, API keys, WorkOS Vault custody, host allowlist      | Done    | x   | x   | Provider definitions are environment configuration. |
| C18 | Bundled read providers: maps/geocoding, news, public records, calendar read, mailbox read | Missing |     | x   | Generic brokered read tools packs bind to. See W4.  |
| C19 | Attachments and files on R2                                                               | Done    | x   | x   |                                                     |

### External action

| Id  | Capability                                                                                                                  | Status  | P   | R   | Notes                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------- | --- | --- | --------------------------------------------------------------------------------------------------------------------------------- |
| C20 | Action proposals, immutable review content, re-validation at approval and dispatch, kill switches                           | Done    | x   | x   |                                                                                                                                   |
| C21 | `policy_controlled` approvals: per action type, auto-execute within declared limits, otherwise human; post-hoc review queue | Missing | x   | x   | Declared in the SDK (`approval: "required" \| "policy_controlled"`); the runtime treats every proposal as human-approved. See W2. |
| C22 | Provider operations with receipts, reconciliation, simulation target                                                        | Partial | x   | x   | Registry is a closed build-time list (`capacity.allocate`). See W1.                                                               |
| C23 | Bundled effect providers: transactional email send, calendar write, CRM/record write                                        | Missing |     | x   | Email send also carries P alerts. See W3/W4.                                                                                      |
| C24 | Financial custody: session keys, API-key signing, per-trade approval, runner signing                                        | Later   | x   |     | Needs the legal read first. See W9.                                                                                               |

### Outbound communication

| Id  | Capability                                                             | Status  | P   | R   | Notes                                                                        |
| --- | ---------------------------------------------------------------------- | ------- | --- | --- | ---------------------------------------------------------------------------- |
| C25 | Outbound webhooks on control-plane events, signed, retried             | Done    | x   | x   |                                                                              |
| C26 | Mobile push delivery (Expo), vaulted tokens, delivery ledger           | Partial | x   | x   | Behind `OPERLOOM_PUSH_ENABLED`; devices registered by the WIP native client. |
| C27 | Email and SMS delivery to users, preferences, digests, delivery ledger | Missing | x   | x   | Same channel abstraction as C26. See W3.                                     |

### Clients and business

| Id  | Capability                                                                                                        | Status  | P   | R   | Notes                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------- | --- | --- | ------------------------------------------------------------------------------------------ |
| C28 | Web console as a `/v1` client                                                                                     | Done    | x   | x   |                                                                                            |
| C29 | Headless `/v1`, `@operloom/client`, `@operloom/react`                                                             | Done    | x   | x   |                                                                                            |
| C30 | Mobile shell                                                                                                      | Missing | x   | x   | To be rebuilt on `@operloom/client`; `codex/mobile-wip` predates v2 and is reference only. |
| C31 | MCP adapter (OAuth, allowlist, MCP Apps widgets) for ChatGPT and Claude apps                                      | Missing | x   |     | See W7.                                                                                    |
| C32 | Billing and entitlements                                                                                          | Missing | x   | x   | See W8.                                                                                    |
| C33 | Signed heavy-tool runner (Fly transport), `runner.ts` in every package                                            | Done    | x   | x   | Same schemas, policy, budgets and receipts as inline tools; optional per pack.             |
| C34 | Runner recipes: headless browser, container or binary execution, document and repository processing, local parity | Missing | x   | x   | Packs write these from scratch today; `repo.snapshot` is the only example. See W11.        |

## Platform build order

Workstreams are generic. Each is inert for a fork that does not declare or
enable it. Order follows how many products each unlocks and how much later
work depends on it.

| #   | Workstream                                                             | Unlocks            | Depends on         |
| --- | ---------------------------------------------------------------------- | ------------------ | ------------------ |
| W1  | Open provider operations to trusted Runtime Modules                    | C22, then C23, C24 |                    |
| W2  | `policy_controlled` approvals and review queue                         | C21                | W1 for effects     |
| W3  | Notification channels: email and SMS beside push; preferences; digests | C27, C26           | W1                 |
| W4  | Bundled connection providers and brokered read/effect tools            | C18, C23           | W1                 |
| W5  | Agent delegation                                                       | C8                 |                    |
| W6  | Pack chat renderers and rich artifact renderers                        | C9, C10            |                    |
| W7  | MCP adapter                                                            | C31                | W6 for widgets     |
| W8  | Billing and entitlements                                               | C32                |                    |
| W9  | Financial custody and signing                                          | C24                | W1, W2, legal read |
| W10 | Mobile shell, rebuilt on `@operloom/client`                            | C30, C26           | W3, W6             |
| W11 | Runner recipes and local runner parity                                 | C34                |                    |

### W1 Open provider operations

Today `provider-operation-registry.ts` is a closed list and ledger projections
require a provider receipt. The change: a trusted Runtime Module declares
provider operations (id, version, input/output schemas, auth class, timeout,
idempotency, simulate) in `control-plane.ts`; the environment binds each to a
connection provider (host allowlist, credential reference). Packages still
never see credentials. Validation refuses an operation whose connection
provider is not configured. Acceptance: `examples/complex-operator` moves its
`capacity.allocate` declaration into the module and the registry file holds no
operations.

### W2 `policy_controlled` approvals

Action bindings may declare an approval policy: limits (count per period,
amount, allowlisted recipients or targets) under which dispatch proceeds
without a human, and a review queue entry either way. Policy is evaluated at
proposal and again at dispatch with current authority; a kill switch or a
breached limit falls back to `required`. Operators edit limits per action type
through agent settings. Acceptance: resource-allocator runs one allocation
unattended under limits and holds the next for review.

### W3 Notification channels

Generalize `notification-delivery.ts` from push-only to channels: push,
email, SMS, outbound webhook. A delivery is a durable record with attempts and
receipts. Users hold per-channel preferences and quiet hours; packs emit typed
notification events; digests are a monitor that folds events since the last
cursor into one delivery. Email and SMS are platform provider operations (W1)
with platform-held credentials. Acceptance: a watch alert reaches email
locally through a recorded transport, and a daily digest folds three events
into one message.

### W4 Bundled connection providers

Ship generic provider definitions and brokered tools packs can bind:
geocoding and routing, news search, calendar read/write, mailbox read and
send (OAuth), transactional email. Each is a connection descriptor plus
Runtime Module tools; nothing is enabled until a workspace authorizes the
connection. Acceptance: a conformance pack binds a calendar read and a
transactional email send under simulation.

### W5 Agent delegation

Decided: a first-class task record. A run creates a task for another agent in
the workspace; the scheduler dispatches it as a run with
`context.run.delegation` (origin run, requester agent, deadline); the result
returns to the parent's history and the parent's root-run budget pays. Depth
and fan-out caps in the manifest bound chains. Shared state plus triggers
stays available for loose coupling but is no longer the coordination model. Acceptance: a conformance pack with two agents
completes a two-step delegated job and the child result is visible in the
parent's history.

### W6 Pack chat renderers

Pack `web.ts` registers renderers for tool results and artifacts by kind,
rendered inline by the assistant-ui thread. Renderers receive bounded, typed
payloads already in the message; they never fetch.

### W7 MCP adapter

Expose the current agent's user-invocable workflows and queries as MCP tools
behind WorkOS OAuth and a per-client allowlist; MCP Apps widgets reuse W6
renderers.

### W8 Billing and entitlements

Plans and entitlements as policy inputs: budgets (C3) read the plan's limits;
usage records feed invoices. Provider-neutral interface, one provider module.

### W9 Financial custody and signing

Deferred until paper trading is proven and the legal read is done. Shape when
it starts: session keys and API keys in Vault, signing in the runner or
broker, every order a `required` or limit-bound `policy_controlled` action
with a receipt.

### W11 Runner recipes

Give `runner.ts` authors reusable, bounded building blocks so heavy work is a
package concern, not a platform fork: a headless browser session with host
allowlist and byte budget, a sandboxed process or container step with
timeout and output cap, document and repository snapshot helpers, and typed
artifact upload. Each recipe reports usage into the run's budget and returns
bounded results under the existing signed callback. The local supervisor runs
the same runner image as Fly so a recipe behaves identically in development.
Acceptance: Repository Analyst's `repo.snapshot` rebuilt on the recipes, and a
conformance pack that scrapes a fixture page through the browser recipe under
simulation.

## Fork posture

A fork chooses its subset without touching platform code:

- Packages declare only what they use; undeclared capabilities never run.
- A fork with no runner tools can leave the runner undeployed; one that needs
  heavy work puts it in `runner.ts`, never in platform code.
- Upstream demo packs are `conformanceOnly` in `workbench.config.ts`.
- Environment gates and provider configuration stay unset for unused channels
  and connections.
- Workspace policy and triggers are disabled by default; an operator enables
  each one.

Gaps found in a fork are built here as generic workstreams and merged down.
Executable specs for W1–W6 and W11 are in
[plans/platform-workstreams.md](plans/platform-workstreams.md); W7–W10 wait
for a later series. See
[forking](forking.md) and [agent packs](agent-packs.md).
