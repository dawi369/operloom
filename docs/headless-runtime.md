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
the package's `models.structured` capability declaration. Workflows and
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
