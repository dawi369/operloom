# Platform workstreams: autopilot specs

One workstream per run, in this order. Each spec is the whole brief: scope,
contract delta, storage, acceptance, gates, non-goals. An agent that needs a
decision not written here stops and asks; it does not invent contracts, add
dependencies, or add service primitives. Capability and workstream ids are
from [capabilities](../capabilities.md).

Decisions already taken:

- W5 uses a first-class task record, not shared state plus polling.
- W7 (MCP), W8 (billing), W9 (live trading custody) and W10 (mobile) are
  out of scope for this series. They stay native platform work for later; no
  work, no stubs. Mobile will be rebuilt from scratch on `@operloom/client`,
  so `codex/mobile-wip` is reference only.
- Frontend-agnostic by construction: every capability lands on `/v1` with a
  `@operloom/client` method first; the web console consumes it like any other
  client. Nothing is reachable only through a Next.js route, a React hook or
  a browser-only path, and renderer contracts (W6) are data-only so a native
  shell can supply its own components.
- Email account choice for any product is fork-time configuration.

Rules for every run:

- No new runtime dependencies. No new Cloudflare bindings, queues or storage
  without a written reason in the PR.
- Forward-only D1 migration under `cloudflare/control-plane/migrations/`,
  `schema.sql` kept in parity (the parity check enforces it).
- New SDK surface is additive, gated by a new entry in
  `implementedRuntimeCapabilities` (`packages/agent-sdk/src/capabilities.ts`)
  so packs negotiate it.
- Every new `/v1` route goes through `public-api.ts` (allowlist, auth, error
  mapping) and gets a `@operloom/client` method.
- Acceptance is a conformance pack or example change plus unit tests; the run
  ends with `pnpm verify:fast`, `pnpm conformance:agent-system`,
  `pnpm test:service-boundaries`, `pnpm agent-packs:compile --check` green.
- Changes land uncommitted for review; CHANGELOG entry drafted.

## Run 1 — W1 Open provider operations

Goal: a trusted Runtime Module declares the provider operations its actions
use; the closed list in `provider-operation-registry.ts` goes away.

Contract delta (`packages/agent-sdk/src/runtime.ts`):

- `ControlPlaneRuntimeModule.providerOperations?: readonly RuntimeProviderOperation[]`
  with `{ id, version, providerId, auth: "bearer" | "hmac-sha256" | "api_key" | "oauth",
method: "POST" | "PUT" | "PATCH" | "DELETE", path, inputSchema, outputSchema,
timeoutMs, idempotency: "header" | "body_field", simulate? }`.
- A tool's `action.providerOperation` must reference an operation declared by
  the same module (compile-time check in the pack compiler).
- Capability `"actions.provider_operations"`.

Control plane:

- `providerOperationReference` resolves from the compiled module registry,
  then binds to a connection provider from environment config by `providerId`
  (host allowlist and credential reference unchanged). A declared operation
  whose provider is not configured fails validation at agent activation, not
  at dispatch.
- Ledger projection keeps requiring a receipt; a `simulate` result is a
  receipt under the simulation target.

Storage: none.

Acceptance:

- `examples/complex-operator` and `examples/resource-allocator` declare
  `capacity.allocate` and `capacity.allocate-signed` in their modules; the
  registry file exports only the resolver and holds no operations.
- Unit tests: unknown provider refused at activation; mismatched
  module/operation refused by the compiler; `pack-test-runtime` runs the
  simulated operation.

Non-goals: new providers, OAuth flows, approval policy.

## Run 2 — W2 `policy_controlled` approvals

Goal: an action may dispatch without a human when it is inside declared
limits; everything is still reviewable.

Contract delta:

- `action.approval: "policy_controlled"` requires
  `action.policy: { limits: ApprovalLimit[] }` where `ApprovalLimit` is one of
  `{ kind: "count", per: "hour" | "day", max }`,
  `{ kind: "amount", field, max, per?: "day" }`,
  `{ kind: "allowlist", field, settingsKey }` (values read from
  `context.settings[settingsKey]`).
- Capability `"actions.policy_controlled"`.

Control plane (`action-authority.ts`):

- At proposal: evaluate limits against `control_action_ledger` for the agent
  and period; decision `auto` or `review`, stored on the proposal with the
  evaluated limits as immutable review content.
- At dispatch: re-evaluate with current authority; any kill switch, a changed
  setting, or a breached limit downgrades to `review`.
- `control_action_reviews` records every auto-dispatched action with
  `kind: "post_hoc"`; `/v1/actions/reviews?status=pending` lists both.
- Settings: owner/admin edit per-action limits through the existing agent
  settings route; schema derived from the declared limits.

Storage: migration adds `approval_decision TEXT` and `approval_evidence TEXT`
to `control_action_proposals`.

Acceptance:

- `examples/resource-allocator` sets `policy_controlled` with
  `count max 1 per day` on `capacity.allocate`. Conformance: first allocation
  dispatches unattended and appears as a post-hoc review; the second waits for
  approval; flipping the pack kill switch holds a third that would have
  passed.
- Unit tests for each limit kind and for the dispatch-time downgrade.

Non-goals: UI for the review queue beyond listing in the operations panel;
amount limits across currencies.

## Run 3 — W3 Notification channels

Goal: push, email and SMS as channels on one delivery ledger, with user
preferences and a digest primitive; packs emit typed notification events.

Contract delta:

- `context.notifications?: { emit(event: { type, title, body, target: { type, id }, severity: "info" | "action" | "alert" }) }`
  (capability `"notifications.emit"`). Events are durable control-plane
  events; delivery is asynchronous.
- Pack manifests may declare `notifications: [{ type, description, defaultChannels }]`.

Control plane (`notification-delivery.ts`):

- Channel enum `push | email | sms | webhook`; `control_notification_deliveries.device_id`
  becomes nullable and `channel TEXT NOT NULL` plus `address_ref TEXT` are added.
- Preferences become per channel and per event type with quiet hours:
  `control_notification_preferences` gains `channel`, `event_type`,
  `quiet_start`, `quiet_end`, unique on `(user, workspace, channel, event_type)`.
- Email and SMS go through platform provider operations (W1) with
  platform-held credentials; the local environment uses a recorded transport
  that writes to the delivery row. Addresses are the WorkOS profile email and
  a user-entered phone stored in Vault.
- Digest: a platform monitor per user/workspace that folds undelivered
  `severity: "info"` events since the last cursor into one delivery at the
  preferred hour.
- `/v1/me/notifications/preferences` GET/PUT; `/v1/me/notifications/deliveries`
  GET.

Acceptance:

- Conformance pack emits an `alert` event from a monitor tick; it reaches
  the recorded email transport within one scheduler tick and once only on
  replay.
- Three `info` events fold into one digest delivery; quiet hours defer it.
- Push path unchanged under the existing tests; device registration stays
  a plain `/v1` route so any future native shell can use it.

Non-goals: templates and branding, provider sign-up, SMS in production.

## Run 4 — W6 Pack chat renderers

Goal: a pack renders its own tool results and artifacts inline in chat.

Contract delta (`packages/agent-sdk/src/runtime.ts`, `web.ts`):

- `WebRuntimeModule.toolResultRenderers?: Record<toolId, ComponentType<ToolResultRendererProps>>`
  and `artifactRenderers` accept React components beside the `json` builtin.
- `ToolResultRendererProps = { toolId, input, output, status, artifactRefs }`;
  components receive only data already in the message and may not fetch.
- Manifest `artifactRenderers[].renderer` may be `"module"`.

Web:

- `components/assistant-ui/tool-fallback` consults the compiled web registry
  by tool id before falling back; artifacts in History and chat use the same
  lookup. Payload size bound enforced before render; oversize falls back to
  the collapsed JSON view.

Storage: none.

Acceptance:

- `examples/document-review` registers a renderer for its report tool and
  artifact; Playwright local acceptance asserts the card renders in chat and
  in History, and that an oversized payload falls back.

Frontend-agnostic: the renderer _registry_ (tool id → renderer id, payload
schema, size bound) is compiled pack metadata exposed on `/v1`; the web
components in `web.ts` are one consumer. A native shell maps the same renderer
ids to its own components and gets the same JSON fallback.

Non-goals: renderers that call `/v1`, renderer streaming, native components.

## Run 5 — W5 Agent delegation

Goal: a run hands a bounded task to another agent in the workspace; the child
result returns to the parent's history and budget.

Contract delta:

- `context.tasks?: { delegate(input: { agentId, workflowType, input, deadlineMs, idempotencyKey }) => Promise<{ taskId }>; result(taskId) }`
  (capability `"tasks.delegate"`).
- `context.run.delegation?: { taskId, parentRunId, requesterAgentId, deadlineAt }`
  on the child.
- `resourceLimits.maxDelegationDepth` (default 2) and
  `maxDelegationFanOut` (default 4) in the manifest.

Control plane:

- Table `control_delegation_tasks` (id, workspace, parent_run_id,
  requester_agent_id, target_agent_id, workflow_type, input, status
  `queued|running|succeeded|failed|expired|cancelled`, result, deadline_at,
  depth, timestamps). Unique on `(parent_run_id, idempotency_key)`.
- Dispatch source `"delegation"` beside `monitor|schedule|webhook`; the leased
  scheduler admits queued tasks as runs for the target agent with the
  target's pinned revision and the parent's root-run budget.
- Policy: target agent must be active in the same workspace, workflow must be
  `userInvocable` or marked `delegable`, depth and fan-out enforced at
  `delegate`. Cancelling the parent cancels queued children.
- Parent history shows child tasks; child traces link to the parent.

Acceptance:

- Conformance pack with two agents: A delegates to B, B commits state and
  returns, A reads the result on its next tick; exceeding depth or fan-out is
  refused; parent cancellation cancels the queued child; a replayed
  `delegate` with the same key returns the same task.

Non-goals: synchronous delegation inside one run, cross-workspace tasks,
chat-level handoff changes.

## Run 6 — W4 Bundled connection providers

Goal: generic brokered providers packs can bind without writing HTTP code.

Scope for v1: geocoding and routing, news search, calendar read and write
(Google and Microsoft via OAuth), mailbox read and send (same), transactional
email send. Each ships as a Runtime Module under `agent-packs/providers-*`
with connection descriptors, tools, provider operations (W1), `simulate`
implementations and recorded fixtures. Environment config supplies hosts,
client ids and credential references; nothing is enabled until a workspace
authorizes the connection.

Acceptance: a conformance pack binds calendar read and transactional send
under simulation; broker tests cover OAuth refresh and revoke for one
provider.

Non-goals: provider sign-up, production credentials, more providers.

## Run 7 — W11 Runner recipes

Goal: `runner.ts` authors compose bounded recipes instead of raw Node code.

Contract delta (`packages/agent-sdk/src/runner.ts`): `recipes.browser({ allowHosts, maxBytes, timeoutMs })`,
`recipes.process({ command, args, timeoutMs, maxOutputBytes })`,
`recipes.repository({ url, depth })`, `recipes.document({ source, kind })`,
`recipes.artifact.upload(...)`. Each reports usage into the run's budget and
returns typed, bounded results through the existing signed callback.

Runner: recipes implemented in `runner/`, Playwright already present for
tests is reused for the browser recipe; the local supervisor runs the same
image as `Dockerfile.runner`.

Acceptance: `repo.snapshot` rebuilt on `recipes.repository`; conformance pack
scrapes a fixture page through the browser recipe under simulation; the pack
still runs with the runner stopped and the tool reports unavailable.

Non-goals: GPU, long-lived sessions, recipe marketplace.
