# Headless runtime (experimental)

The Worker serves only `/v1` to the network; the bundled web console is a `/v1`
client too. The API calls the canonical authorization and command handlers.
Every operational request identifies its workspace and agent, explicitly or
through `/v1/me`; selecting a different workspace in another client cannot
redirect it.

## Local operation

Initialize local Worker configuration and apply forward migrations using the
existing setup. The Worker needs its D1 bindings and
`OPERLOOM_LOCAL_API_TOKEN`; chat also needs
`OPERLOOM_AGENT_CONNECTION_SECRET` and a server-side model provider key.

```sh
pnpm db:cloudflare:migrate:local
pnpm dev:runtime
```

The supervisor starts only Wrangler on `127.0.0.1:8787`; it does not load
`.env.local`, start Next, start React, or require web auth callback variables.
Runner-backed tools need the signed runner as well (`pnpm operloom dev` starts
all services). Use `pnpm conformance:runtime` for a disposable migrated D1/Worker
journey using deterministic chat without a model provider.

The local adapter requires all three: `OPERLOOM_LOCAL_API_ENABLED=true`,
`OPERLOOM_ENVIRONMENT=local`, and a loopback request URL. The supervisor supplies
these flags; the token is read from Worker configuration. Caller identity and
role headers are discarded. Local identity defaults to `operloom-local`, or the
server-configured `OPERLOOM_LOCAL_API_USER_ID`.

## Independent deployment artifact

`pnpm runtime:bundle` creates a new directory under `output/runtime-distribution/`.
`latest.json` points to it. The artifact contains the bundled Worker, copied
forward D1 migrations, a standalone Wrangler configuration, a checksum manifest,
and a package with Wrangler as its only development dependency. The bundler checks
that Next, React, assistant-ui and the Next WorkOS adapter are absent from the
dependency graph; unresolved package imports are rejected.

For another environment, pass `--config <rendered-worker-config.json>` to the
bundle command. Resource names, signing-header code and provider resource IDs
are preserved. Secret files are not copied. Review configuration variables before
distributing the artifact. The command only performs a Wrangler dry run.

Copy the artifact directory to a machine without the source checkout. Within it:

```sh
pnpm install --ignore-workspace
pnpm exec wrangler d1 migrations apply DB --remote
pnpm run deploy
```

Before those remote commands, verify the target account/resource IDs, take a D1
backup, set server secrets through Wrangler, and configure the WorkOS variables
below. A fresh installation needs its own provisioned D1/R2 resources; the default
artifact intentionally retains local placeholder IDs. An existing installation
must retain its signing secrets and migration history. Run the hosted acceptance
suite against the same bundle before enabling the new capability flags. Heavy
runner and graph delegation services remain separately deployed when needed.

For local artifact acceptance, install its pinned Wrangler dependency and run
`pnpm exec tsx scripts/run-runtime-conformance.ts --standalone` from the source
repository. The test launches the prebundled Worker from the artifact directory,
without importing application source or frontend dependencies. The test harness
itself uses repository Playwright tooling. Acceptance rejects a missing or
parent-workspace Wrangler installation; use `pnpm install --ignore-workspace`
inside the artifact directory. Scheduler drills use Miniflare's native handler
dispatch, preserving the no-bundle artifact instead of requiring injected
Wrangler test middleware.
The journey also verifies native workflow absence independently, injects a final
D1 cleanup failure, and completes the disposable workspace purge after operator
retry. This uses local-only fault injection; it does not alter hosted grace periods.

The packaging uses Cloudflare's documented
[dry-run and no-bundle deployment](https://developers.cloudflare.com/workers/wrangler/bundling/).

## Production authentication configuration

Hosted Workers verify WorkOS access tokens. Configure these Worker variables
alongside the existing deployment configuration:

```text
OPERLOOM_LOCAL_API_ENABLED=false
OPERLOOM_WORKOS_ISSUER=<exact token issuer, including path/trailing slash>
OPERLOOM_WORKOS_JWKS_URL=<HTTPS signing-key endpoint>
OPERLOOM_WORKOS_ALLOWED_CLIENT_IDS=<comma-separated authorized client IDs>
```

Clients obtain and refresh access tokens through WorkOS. The API checks RS256
signature, exact issuer, subject, issued-at, expiry, and authorized client claims.
Membership and administrative permissions come from canonical Operloom records;
JWT role claims cannot restore a revoked existing membership. User rows record
`email` and `name` only when a WorkOS JWT template adds those claims. Secrets
stay on the server.

`GET /v1/account` authenticates/bootstrap-resolves the account using existing
platform rules. Subsequent operations use:

```text
/v1/workspaces/{workspaceId}/agents/{agentId}/{operation}
```

`GET /v1/openapi.json` includes generated chat schemas and the administrative
method/path inventory. Complete administrative request/response schema generation
remains a milestone gate. Internal callback,
credential redemption, SDK transport and platform-operator routes are absent.
Workspace deletion additionally requires a recent signed `auth_time`; a client
body timestamp is never trusted on this API. Tokens without that claim cannot
perform headless deletion yet.

## Fetch consumer

```ts
import { createRuntimeClient } from "@operloom/client";

const runtime = createRuntimeClient({
  baseUrl: "https://your-worker.example",
  target: { workspaceId, agentId },
  getAccessToken: async ({ forceRefresh, minValidityMs }) =>
    yourAuthAdapter.token({ forceRefresh, minValidityMs }),
});
const { threadId } = await runtime.threads.create();
await runtime.threads.submit(threadId, "Summarize current capacity", crypto.randomUUID());
const transcript = await runtime.threads.messages(threadId);
const events = runtime.events();
for await (const event of events) {
  if (event.type === "reset") {
    // Refetch canonical resources; the retained event cursor has expired.
  }
}
// events.close() or an AbortSignal stops observation.
```

`createFetchChatTransport({...options, threadId})` implements the existing
headless chat transport interface. Commands work before `connect()`. SSE wakes
canonical reads; transcript polling covers stream outages. Closing a client
stops observation, not server execution. `cancel()` requests the existing
runtime cancellation behavior. Provider physical abort remains best effort.

HTTP errors carry a request ID and code. The Fetch client refreshes a rejected
token once, preserves command identity, and never automatically retries ambiguous
mutation failures. Replayed chat keys reject changed content. Thread-local durable receipts
retain replay identity independently of transcript pruning. Each thread accepts at
most 10,000 command identities; new commands then require another thread. Receipt
export and deletion follow thread lifecycle. Acceptance does not yet guarantee
resumable model execution after interruption.

The generic `runtime.request(path, options)` covers administrative APIs, including
approvals, triggers, connections, retention, export, deletion and kill switches.
Convenience methods cover common reads and export submission. Existing role
requirements and feature gates still apply. Export download is a binary HTTP
response and should be fetched with the authenticated URL directly.

### MCP adapter

`POST /v1/me/mcp` (or the explicit workspace and agent scope) serves the active
agent as an MCP server over Streamable HTTP, stateless: `initialize`, `ping`,
`tools/list` and `tools/call`. Every user-invocable workflow becomes
`workflow_<type>` and every query `query_<id>`; a call runs the same
`/workbench/workflows/{type}` or `/queries/{id}` operation the console uses,
so policy, budgets, approvals and history apply unchanged. Results carry
`structuredContent` plus `_meta["operloom/renderer"]` (the artifact kind) so
an MCP Apps widget can reuse the pack's data-only renderers. Authentication
is the same WorkOS bearer as the rest of `/v1`; the token's client id must
also appear in `OPERLOOM_MCP_ALLOWED_CLIENT_IDS`. Unauthenticated calls get a
`WWW-Authenticate` challenge pointing at
`/.well-known/oauth-protected-resource`, which names the WorkOS issuer so
ChatGPT and Claude connectors can complete OAuth on their own.

### Console client against the Worker

`createWorkbenchClient` and `createWorkbenchRealtimeAdapter` default to the
console target, where paths are Next.js routes under `/api/workbench`. With
`target: "control-plane"` and `baseUrl: "https://your-worker.example/v1/me"`
the same methods map onto the Worker's `/v1/me` operations through
`packages/client/src/route-map.ts`; a unit test proves every method lands on an
allowlisted route. Operations that exist only in the console (WorkOS account
listing) reject with `console_only_operation`. The Expo shell in `apps/mobile`
uses this target together with `createRuntimeClient` for chat threads.

### State and delivery operations

When typed state is enabled, active members can inspect the agent package's records
and immutable decision/effect entries. Specify the simulation/external target
on every query; the server resolves package and tenant scope.

```ts
const page = await runtime.state.records({
  target: "simulation",
  namespace: "capacity",
  kind: "pool",
  limit: 50,
});
const decisions = await runtime.state.entries({ target: "simulation", type: "decision" });
const failures = await runtime.state.deliveries({ target: "simulation", status: "failed" });
// Owners/admins only. A stale count or changed status returns 409; refetch first.
for (const delivery of failures.deliveries) {
  await runtime.state.retryDelivery(delivery.id, {
    target: "simulation",
    expectedAttempts: delivery.attempts,
  });
}
```

Use `nextCursor` with the same target and filters for subsequent pages. These
operations have generated OpenAPI schemas and Fetch response validation. A retry
returns `202` after durable acceptance; the scheduler publishes the original
canonical event. It does not dispatch an external provider action.

## Delivery boundary

Owners/admins can also start a registered state migration and advance bounded
batches. After a disconnect, list canonical progress; replaying an advancement
revision returns the original receipt.

```ts
const catalog = await runtime.state.migrations({ target: "simulation" });
let { migration } = await runtime.state.startMigration("capacity-v2", "simulation");
while (migration.status === "running") {
  ({ migration } = await runtime.state.advanceMigration(migration.id, {
    target: "simulation",
    expectedRevision: migration.revision,
  }));
}
```

The client supplies no transformation or raw scope. Start pins a reviewed plan
and both schemas; advance preserves record identity and increments versions.
See migration bounds and recovery limits.

For a failed transformation, deploy a reviewed replacement declaration retaining
the original schemas/indexes, then explicitly repair the remaining records:

```ts
const { migration: repaired } = await runtime.state.repairMigration("capacity-v2", {
  target: "simulation",
  expectedRevision: migration.revision,
  replacementId: "capacity-v2-repair",
  idempotencyKey: crypto.randomUUID(),
});
// Advance repaired.id at repaired.revision; completed records stay unchanged.
```

Keep the same command key and body when retrying a lost repair response. A stale
revision or changed command payload returns `409`; fetch canonical progress.

Local conformance proves local credentials, thread creation, HTTP acceptance,
Node/browser submission, canonical transcript after reconnect, replay/conflict,
isolation, policy-bound inline-tool approval, export completion, checksum-verified
download, and quarantine/recovery without Next. It does not prove WorkOS hosted
login, an approved external effect, hosted restore, automatic workflow restart
or a 24-hour automation soak. The gated native adapter exercises local steps and
timer waits; explicit-wake process replay is separate from automatic recovery. See
delivery evidence before enabling production access.

## Notification channels

Users choose how package and platform events reach them:

```ts
await runtime.notifications.setAddress({ channel: "sms", address: "+15555550100" });
await runtime.notifications.setPreference({
  channel: "email",
  enabled: true,
  quietStart: 22,
  quietEnd: 6,
  digestHour: 8,
});
await runtime.notifications.setPreference({
  channel: "sms",
  eventType: "capacity.escalated",
  enabled: true,
});
const { deliveries } = await runtime.notifications.deliveries({ limit: 20 });
```

A preference row for an event type wins over the channel's `*` default. Hours
are UTC. Email falls back to the signed-in profile address; SMS needs a stored
number. Deliveries list channel, severity, status, attempts and the next send
time for a deferred row. Email leaves the Worker directly when
`OPERLOOM_EMAIL_PROVIDER=resend` with `RESEND_API_KEY` and `OPERLOOM_EMAIL_FROM`
(a sender on a domain verified in Resend; `OPERLOOM_EMAIL_REPLY_TO` is
optional). Each send carries an idempotency key of event type, target and
address so a retried delivery row never mails twice; 429 and 5xx are retried,
other 4xx mark the row failed. Otherwise, and for SMS, egress uses the platform
relay configured by `OPERLOOM_NOTIFICATION_RELAY_URL` and
`OPERLOOM_NOTIFICATION_RELAY_SECRET` (signed like outbound webhooks); without
one the delivery is recorded only. E2E mode always records.

## Webhook notifications

Owners/admins subscribe an HTTPS endpoint to their control-plane events (exact
types, `prefix.*` patterns or `*`). The signing secret is returned once:

```ts
const { endpoint, secret } = await runtime.webhooks.create({
  url: "https://hooks.example.com/operloom",
  eventTypes: ["agent.settings.changed", "run.*"],
});
const failed = await runtime.webhooks.deliveries(endpoint.id, { status: "failed" });
await runtime.webhooks.retry(endpoint.id, failed.deliveries[0].id);
```

The scheduled tick delivers events at least once, about 30–90 seconds after
they are recorded. Each POST carries `x-operloom-webhook-id` (dedupe on it),
`x-operloom-event`, `x-operloom-timestamp` (Unix seconds) and
`x-operloom-signature: v1=<base64url HMAC-SHA256(secret, "<timestamp>.<raw body>")>`.
Reject stale timestamps. Non-2xx responses and redirects are retried with
exponential backoff (1 minute doubling to 1 hour) for 8 attempts, then marked
`failed`. Disabling an endpoint fails its pending deliveries. Delivery records
are kept for 30 days.

## Chat command outcomes

New HTTP turns return `commandId` alongside the accepted message identity.
`client.threads.command(commandId)` reads the canonical outcome using
`GET /chat/commands/{id}` under the same explicit workspace/agent scope. Commands
report `pending`, `running`, `completed`, `failed` or `cancelled`, with acceptance
time, run identity and a bounded error code. Historical local-only receipts may
omit `commandId` when replayed.

Only one pending/running command is admitted per thread. D1 registers it before
HTTP acknowledgement and links it to one execution run atomically. Reconnection
and same-key replay observe the original command; they do not repeat model work.
The existing scheduler inspects at most 100 expired commands per tick. A two-minute
deadline closes abandoned work and fences late execution; export fences defer
recovery writes. Review a failed outcome before explicitly sending a new key.
Command outcomes are included in workspace exports and removed on purge.

This provides observable interruption handling, not resumable model execution.
See admission and crash boundaries.

## Explicit package upgrades

With `OPERLOOM_PACKAGE_UPGRADES_ENABLED=true` on an isolated local/acceptance
Worker, owners/admins use the same explicit client target:

```ts
const history = await runtime.packages.snapshots();
if (history.availableVersion && history.availableVersion !== history.currentVersion) {
  const receipt = await runtime.packages.upgrade({
    targetVersion: history.availableVersion,
    expectedRevision: history.currentRevision,
    idempotencyKey: crypto.randomUUID(),
  });
}
```

Persist the command body/key before sending, and reuse both on an ambiguous
response. GET `/workbench/package-snapshots` supports `beforeRevision` pagination;
POST `/workbench/package-upgrades` has generated validators/OpenAPI. The installed
registry determines the destination; clients cannot upload code or prompts.
Read compatibility, active-work fences and validation bounds
before upgrading. Hosted renderers leave this capability disabled.

## Model/tool budgets

Each workspace starts with a default policy; owners/admins change it through
`client.budgets.update({ expectedVersion, idempotencyKey, limits })`. Both daily
workspace and canonical root-run limits
are enforced before dispatch. Owners/admins inspect `client.budgets.get()` and
`client.budgets.usage({ day, limit, cursor })` using the same explicit target and
authentication. Listen for `usage.reserved`, `usage.settled` and `budget.updated`
events, then fetch canonical usage. Workflow structured calls additionally require
the package's `models.structured` capability declaration. Each call sees the
run's context snapshot unless it passes `includeContext: false`, which keeps a
judgment to the evidence in its prompt. Workflows and
model-visible tools that declare
`search.web` get `context.search.web({ idempotencyKey, query, maxResults,
publishedAfter, publishedBefore })`: dated web results from the Worker's
`EXA_API_KEY`, metered as tool usage and replayed by operation key. A
`publishedBefore` cutoff drops results that are later or undated, so evidence
can be pinned to what was known at a point in time. Local E2E mode returns a
deterministic fixture; elsewhere a missing key fails with
`search_provider_unconfigured`.
See model/budget semantics and the
[document-review example](../examples/document-review/README.md) for complete setup.

## Plans and entitlements

A workspace's plan is a policy input, not a payment flow. `config/billing.json`
declares every plan with a budget ceiling (`limits`, the same shape as the
budget policy), a feature set (`delegation`, `notifications.relay`, `runner`)
and seats; `defaultPlanId` is the plan of any workspace without a subscription.
`client.budgets.update` refuses limits above the ceiling (`budget_exceeds_plan`),
first-use bootstrap writes `min(default, plan)`, and a plan change clamps the
stored policy down in the same batch, so admission SQL is unchanged.
`client.billing.get()` returns the provider, the resolved entitlements and the
subscription; `/workspace-context` carries `entitlements` too. Packs that declare
`entitlements.read` see `context.entitlements` and can degrade a workflow by
plan instead of failing.

```ts
const { entitlements } = await client.billing.get();
await client.billing.assignPlan({ planId: "team", seats: 5 }); // manual provider
const { url } = await client.billing.checkout({
  planId: "team",
  successUrl: "https://app.example/billing?ok",
  cancelUrl: "https://app.example/billing",
}); // stripe provider
const { days } = await client.billing.usage({ from: "2026-01-01", to: "2026-01-31" });
await client.billing.reportUsage({ day: "2026-01-31" });
```

`OPERLOOM_BILLING_PROVIDER` selects the module: `manual` (default) lets an
owner/admin assign plans directly. `polar` is the merchant-of-record option
(Polar handles tax and invoicing): `POLAR_ACCESS_TOKEN` creates checkouts and
customer-portal sessions, plans match by `providerPrices.polar` (a product id),
and `POST /billing-ingress/polar` verifies Standard Webhooks headers with
`POLAR_WEBHOOK_SECRET`; `subscription.*` events update the row, usage is
ingested as `operloom_tokens` events keyed by the workspace as external
customer. `stripe` uses `STRIPE_SECRET_KEY` for hosted checkout and the billing
portal, matches plans by `providerPrices.stripe`, and verifies
`Stripe-Signature` with `STRIPE_WEBHOOK_SECRET`; `checkout.session.completed`
and `customer.subscription.updated|deleted` update the row and usage posts as
meter events. The console forwards both at `/api/billing-webhooks/{provider}`.
Daily usage reports aggregate settled reservations, run on the scheduler tick
for the previous day and are idempotent per workspace and day; the manual
module records them as `skipped`. Neither external module has been exercised
against a live account yet.

## Experimental durable submission

With the native Workflows binding configured and
`OPERLOOM_DURABLE_WORKFLOWS_ENABLED=true`, a v2 workflow that declares `durable`
can be submitted through the same explicit workspace/agent route:

```ts
const accepted = await client.request("/workbench/workflows/document-review.review", {
  method: "POST",
  idempotencyKey: "review-document-42",
  body: {
    execution: "durable",
    executionMode: "dry_run",
    input: { documentId: "document-42", text: "The document to review." },
  },
});
```

The HTTP response is `202`; inspect `accepted.run.id` through canonical run history.
Retry the same key and body after a lost response. Changed content conflicts.
Cron retries pending engine starts in bounded batches. The feature defaults off;
durable execution lists the outstanding hosted restart,
handler-retention and engine-lifecycle gates. Request-mode workflows
continue to use the existing command behavior.

Standalone artifacts now include a guarded deployment command. After forward
migration 0030 and secret configuration, use `pnpm run deploy -- --origin
https://<worker-origin>`. It inspects active handler pins inside the frozen
candidate while D1 fences new admissions, then verifies the deployed identity
before activating its generation. Existing executions remain resumable. Preserve
the artifact and its evidence after an uncertain upload; see the
deployment recovery commands.

### Durable recovery operations

Create a declared trigger through `POST /triggers` with `execution: "durable"`
to use the same v2 binding for schedule, monitor, manual or webhook dispatch.
Omitting the field retains request execution. Execution mode is fixed at creation;
changing it requires a separate trigger. Monitor/schedule occurrences coalesce into
one pending observation, while manual/webhook intake allows at most 100 pending
events per durable trigger. Reusing a delivery key with changed content conflicts.
Pausing or materially changing a trigger cancels its active durable runs. The
legacy dispatch replay route rejects an already admitted durable event.

The scheduled Worker reconciles at most sixteen due executions per tick, with
four concurrent inspections, 90-second claims and five-second engine-call
bounds. Failed inspections back off from 30 seconds to fifteen minutes. Active
export fences defer affected rows. `durable.recovery` logs contain only selected,
claimed, closed, deferred and failed counts; D1/export records retain bounded
status/error codes and the next due time. No provider exception text is stored.

Canonical cancellation revokes future effect authority immediately. The next
recovery tick terminates a surviving instance and later confirms its terminal
status. Deadline expiry and engine failures close the canonical run with events;
ambiguous attempts remain `outcome_unknown`. Recovery never calls engine restart
or recreates an instance whose D1 execution has started. These operations do not
supply the still-required operator reconciliation UI. Native engine deletion
precedes workspace purge and retains progress across cleanup failures.

### Context history across durable waits

Use `client.context.list({ runId, runKind: "workflow", limit: 20 })` to retrieve
ordered capture metadata. Pass `nextAfterRevision` as `afterRevision` for the next
page. `client.context.snapshot(id)` loads the full immutable evidence on demand.
A run's latest snapshot pointer can advance; decisions preserve the specific
snapshot IDs used. New durable steps capture fresh evidence and same-step retries
retain their original capture. Required stale evidence still blocks execution.

### Memory

Memory records are durable facts the platform carries into every chat turn.
`kind` is one of `goal`, `preference`, `watchlist`, `conclusion`, `note`. A
record's `scope` is `user` (one person, every agent), `agent` (one person, one
agent) or `workspace` (shared with every member; written by owners and admins).
Writing the same `(kind, key, scope)` again replaces the earlier record. An
optional `target: { type, id }` says what the record is about (a market, a job,
a customer) so clients and workflows can list by subject.

- `client.memory.list({ kind?, scope?, status?: "active" | "proposed" | "archived" | "all", targetType?, targetId?, limit? })`
- `client.memory.remember({ kind, key, title, content, scope?, target? })` writes
  as the user (`source: "user"`, always `active`, never expires). The Worker
  route is `PUT /v1/me/workbench/memory/{kind}/{key}`.
- `client.memory.confirm(id)` activates a proposal; `client.memory.forget(id)`
  archives a record. Archived and expired records never enter the prompt.

**Who wrote it decides how much the platform trusts it.** User records are
authoritative. Model (`memory.remember` chat tool) and workflow
(`context.memory`) records are dated claims: they carry `expiresAt`, are shown
to the model with their source and date, are marked "stale, re-verify" past
half their life and archived on the scheduler tick when they expire. Whether
such a write lands `active` or `proposed` is the pack's choice (see the
`memory` manifest block in the pack guide); packs with `risk.financialData`
propose everything unless they say otherwise. A proposal records a
`memory.proposed` control-plane event and a push with `route: "memory"`. A
model write never downgrades a record the user activated.

Writes are refused with `422 memory_content_refused` when they contain
credentials or card numbers, and with `422 memory_content_invalid` when the
pack declared a content schema for that kind and the content does not match.
Records containing an email address or phone number carry the `contact` flag.
Limits per user: 8 KiB per record, 200 active records and 256 KiB total
(`409 memory_quota_exceeded`).

Each chat turn is assembled from, in order: a `# Memory` section ("what the
user told you", then "what this agent concluded earlier" with source and date,
then proposals awaiting confirmation; 24 KiB budget), the five most recent
artifact summaries, the context snapshot grouped by trust level, a digest of
transcript messages dropped to stay within the 48,000-character budget, and
the retained transcript. The ids of the recalled records are pinned into the
turn's context snapshot as the `platform.memory` source, so an approval or a
later review can show exactly what the agent believed when it proposed
something. Records are tenant-scoped, included in workspace exports and removed
by workspace purge.

Owners and admins see every member's memory through
`client.admin.memory.list({ status?, kind?, userId?, q?, limit? })`
(`GET /v1/me/admin/memory`), which also returns the member list and the active
agent's effective policy, and edit any record with
`client.admin.memory.update(id, { title?, content?, kind?, status?, target?, expiresAt? })`
(`PATCH /v1/me/admin/memory/{id}`). Admin edits pass the same content guard and
append a `memory.admin_edited` control-plane event naming the record's owner.
`client.admin.memory.bulkArchive({ status?, kind?, userId?, target?, olderThanDays? })`
archives every matching non-archived record in one call (at least one filter is
required) and records `memory.admin_bulk_archived`; pass `preview: true` to get
the count without archiving. Pending approval requests carry `memoryUsed`, the
records that were in the prompt when the request was raised, read back through
the run's pinned context snapshot; the list response includes
per-member `usage` against the limits. The console exposes all of this as the
Memory tab of the admin panel.

### Fleet board

`GET /v1/me/workbench/fleet` answers once for the whole workspace: every agent
with a derived `status` (`waiting_approval` > `running` > `erroring` > `idle`;
`paused` when the agent row is not active), the current run and stage, the
last finished run and its summary, open approvals, runs and failures today,
settled tokens today, enabled and paused triggers with the earliest
`nextTickAt`, and the most recent failed run. It is computed from
`control_runs`, `control_triggers`, `control_approval_requests` and
`control_resource_reservations`; nothing is stored. The console opens it from
`/fleet` in the command palette and the mobile app has a Fleet tab. Both use
`useWorkbenchFleet`, which refetches on `workflow.run.updated`,
`tool.run.updated`, `approval.updated` and `action.updated` session events and
every 30 seconds for scheduler ticks that emit none.

### Audit feed

`client.admin.events.list({ type?, userId?, q?, before?, limit? })`
(`GET /v1/me/admin/events`) returns every control-plane event in the workspace
for owners and admins, newest first, with the actor's label. `type` is an exact
type or a prefix ending in `.` (`memory.`); `before` is the id of the last event
seen, for paging; the response carries the distinct `types` seen in the
workspace and `nextBefore` when more remain. The console shows this as the
Audit tab of the admin panel.

### Provider action inspection and recovery

`client.admin.actions({ limit: 25 })` retrieves proposal, review binding, ledger,
redacted dispatch receipt and last observed resource lifecycle. This is a bounded
recent list; action pagination is still pending. `admin.requestAction(id)` returns
an approval identity at `202`. Approve/deny through the scoped approvals API.
`admin.reconcileAction(id)` returns the canonical result, with `ok: false` and
`202` while uncertainty remains. It never resubmits a provider mutation.

The no-dispatch outcome means the backend proved receipt absence and atomically
revoked future dispatch for that attempt. A reconciled action may therefore have
no external effect. A succeeded receipt with a pending lifecycle means only that
submission was accepted. Web History displays these same distinctions.

Run `pnpm conformance:provider-operations` for isolated native Worker, public API,
Fetch client and independently verified bearer/HMAC fixture acceptance. It makes
no hosted provider or model calls and starts no Next.js server. Hosted provider
operations remain disabled until their separate acceptance gates pass.
