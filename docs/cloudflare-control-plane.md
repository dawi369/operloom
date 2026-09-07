# Cloudflare Control Plane

Cloudflare is the live multi-user control plane for operloom. It owns
coordination, authorization, normal chat session state, policy, and canonical
control-plane writes. It does not own arbitrary heavy execution.

Document status: Cloudflare currently owns users, accounts, workspaces,
memberships, active workspace preferences, workspace-scoped agents, active
agent preferences, normal chat coordination, Admin summaries, diagnostic runs,
tool policy, approvals, runtime traces, execution/artifact history metadata,
customer-facing workspace/member administration, run recovery controls, and
control-plane events. The retained-data foundation now includes artifact
lifecycle metadata, bounded retention sweeps, and durable operator alerts.
Secret custody, invitation lifecycle, mutation-capable tools, provisioned R2,
and complete customer export/delete remain target work.

## Responsibilities

Use Cloudflare for:

- Trusted user/workspace/agent authorization.
- User-facing chat/session coordination.
- Cloudflare Agents normal live chat.
- D1-backed run, policy, tool, audit, trace, and event records.
- Durable Object session snapshots and per-thread hot state.
- Typed workflow intent creation.
- Tool exposure and execution policy.
- Scoped callbacks from Fly/LangGraph.
- Browser-visible runtime summaries and live-session events.

Do not use Cloudflare as the default runtime for arbitrary CLIs, Python-heavy
workflows, browser automation, long CPU-heavy jobs, native dependencies, or
tools that need a normal Linux container. Those belong in Fly tool runners or
other server-side execution services.

## Storage

- Durable Object state / Durable Object SQLite: session coordination and hot
  per-thread messages.
- D1: relational product/control-plane state: users, workspaces, memberships,
  agents, preferences, chat/control runs, tool permissions, approvals, audit
  events, traces, and events.
- R2: mediated blobs such as logs, reports, screenshots, exports, and research
  bundles. `ARTIFACTS` is declared in Wrangler and exercised through local R2;
  hosted environments must provision the named bucket before deployment.

Forward-only D1 changes live in `cloudflare/control-plane/migrations/` and use
Wrangler's migration ledger. `cloudflare/control-plane/schema.sql` remains the
destructive reset snapshot for deliberate dev resets. Standard artifacts
expire after 90 days, operational events after 30, and runtime traces after 14
unless a workspace admin sets a bounded policy. The remaining hosted restore,
R2 recovery, export, and deletion gates are tracked in
`docs/migrations-and-retention.md`.

## Tenant Boundary

Every Cloudflare entry point must derive tenant scope from trusted
auth/session/trigger context. The model and browser must not provide trusted
`userId`, `workspaceId`, `threadId`, or `agentId`.

Hosted web requests use WorkOS AuthKit in Vercel/Next. Vercel maps WorkOS
user, account source, and external role/permission signals into a
server-to-server Cloudflare call. Cloudflare resolves the internal user, active
workspace, membership, and active agent before reading or writing state.

Local development can fall back to server-derived `WORKBENCH_DEV_*` identity
only when `WORKBENCH_ALLOW_LOCAL_DEV_IDENTITY=true` and the runtime is not
production. Hosted production fails closed if WorkOS is incomplete.

`GET /health/live` remains a shallow process liveness check. `GET /health`
requires the D1 query, `ARTIFACTS` R2 binding, and both Cloudflare Agent Durable
Object bindings to be present without returning their names, ids, or tenant
data.

Current customer access routes:

- `GET/POST /workspaces`
- `POST /workspaces/:workspaceId/activate`
- `GET/POST /workspaces/:workspaceId/members`
- `PATCH /workspaces/:workspaceId/members/:userId`

Active members can switch assigned workspaces. Workspace creation and member
administration require owner/admin role. Admins cannot edit owners or grant
owner, self-lockout is denied, and the final active owner is protected. New
members must already have an active membership in the same account's default
workspace, which prevents cross-account user-id admission.

## Chat Runtime

Normal hosted chat uses Cloudflare Agents directly:

```txt
Vercel session facade
  -> Cloudflare resolves active workspace/member/agent/thread
  -> WorkbenchSessionAgent returns session snapshot and short-lived token
  -> browser connects to WorkbenchThreadChatAgent
  -> Agent streams OpenRouter and mirrors compact metadata to D1
```

The latency-sensitive message path should stay small: verify the scoped Agent
token, read cached runtime/behavior config from the Durable Object, write the
minimal D1 run-start mirror, then contact OpenRouter. Completion mirrors,
trace spans, event writes, and thread-touch updates should happen after
streaming starts or through `waitUntil` when correctness allows it.

Fly/LangGraph remain available for graph-shaped workflows, heavy tools,
browser automation, and explicit escalation. They should not be the default
path for a plain message.

## Live Session Events

The browser-visible workbench state converges on the scoped
`WorkbenchSessionAgent` stream:

- Cloudflare: `GET /chat/session/stream`
- Vercel facade: `GET /api/workbench/chat-session/stream`

The stream can emit compact `session.snapshot`, thread create/activate/refresh
events, chat run lifecycle events, tool updates, trace updates, and Admin
summary invalidation. Payloads are hints over canonical D1 and Durable Object
state; they must exclude tokens, prompts, secrets, raw provider payloads, and
full tool output.

Tool runners and future Fly/LangGraph workflows should publish progress by
calling scoped Cloudflare callbacks that update D1 first, then notify the
matching session Agent. The browser should not subscribe to Fly directly for
product/runtime state.

Current v0 callback ingestion uses `POST /workbench/run-callbacks`. Producers
sign the request with `WORKBENCH_CALLBACK_SIGNING_SECRET`; Cloudflare resolves
tenant scope from the stored run, accepts compact lifecycle/artifact metadata,
and emits `workflow.run.updated` plus Admin invalidation hints. Callback-backed
tool calls also emit `tool.run.updated`. There is no unsigned or internal
callback compatibility route.

## Runtime Traces

D1 is the first-party runtime trace store. The Worker writes `runtime_traces`
and `runtime_spans` for scoped chat/thread/tool operations so Admin can answer
which service was hit and where latency accumulated.

Current trace kinds include:

- `chat.thread.create`
- `chat.agent.stream`
- `chat.run.stream` for legacy/simple-chat transition paths
- `tool.url.inspect`
- `tool.repo.snapshot`
- `tool.runner.echo`
- `tool.diagnostic.ping`
- `tool.artifact.metadata.test`

Trace reads are scoped after the same identity resolution as every other
workbench route:

- Cloudflare `GET /runtime/traces/latest?limit=10`
- Cloudflare `GET /runtime/traces/:traceId`
- Vercel `GET /api/workbench/runtime-traces/latest`
- Vercel `GET /api/workbench/runtime-traces/:traceId`

Trace payloads must stay compact and redacted. Store operational metadata such
as model id, run id, safe URL summary, duration, status, and error code. Do not
store prompts, auth headers, provider secrets, full provider payloads, or full
tool output.

## Workbench History

D1 is also the first workbench history store. The Worker exposes scoped
metadata reads for execution and artifact history:

- Cloudflare `GET /workbench/history/runs?limit=25`
- Cloudflare `GET /workbench/history/runs/:runId`
- Cloudflare `POST /workbench/history/runs/:runId/cancel`
- Cloudflare `POST /workbench/history/runs/:runId/retry`
- Cloudflare `GET /workbench/history/artifacts?limit=25`
- Vercel `GET /api/workbench/history/runs`
- Vercel `GET /api/workbench/history/runs/:runId`
- Vercel `POST /api/workbench/history/runs/:runId/cancel`
- Vercel `POST /api/workbench/history/runs/:runId/retry`
- Vercel `GET /api/workbench/history/artifacts`

These endpoints expose run summaries, action availability, tool-call counts,
compact stored run snapshots, pending approval interventions, and artifact
metadata. Cancellation is accepted only for queued/running/waiting runs.
Retry is implemented for failed/cancelled Polymancer and Swordfish pack
workflows and creates a new run from the stored typed input. They do not provide
raw logs, prompts, or secrets. Mediated blob writes and reads are available at
`POST /workbench/artifacts` and `GET /workbench/artifacts/:id/content` only when
the Worker has an `ARTIFACTS` R2 binding; missing storage fails closed. The
`/history` workbench surface makes this product-visible state and recovery available outside Admin, while
Admin still carries deeper diagnostics.

## Unattended Failure Alerts

Trigger execution rejection and expired-lease recovery atomically create a
deduplicated `control_operator_alerts` record with the dispatch failure. This
means a terminal unattended failure cannot exist only in logs. Workspace
owners/admins can inspect alerts at `GET /admin/operator-alerts` and acknowledge
or resolve them with `PATCH /admin/operator-alerts/:id`; resolution writes an
audit event. The Agent & Packs Automations panel exposes the same scoped alert
list, failed-delivery retry, acknowledgement, and resolution controls through
the Vercel facade; ordinary members do not fetch the admin-only resource.

When `WORKBENCH_OPERATOR_ALERT_WEBHOOK_URL` and
`WORKBENCH_OPERATOR_ALERT_SIGNING_SECRET` are both configured, the scheduled
Worker delivers open alerts in bounded batches. The destination must be HTTPS
on port 443 without URL credentials. Redirects are rejected, delivery times out
after five seconds, payloads are HMAC-signed, and compare-and-set attempt counts
cap automatic delivery at five tries. The receiver must deduplicate on
`x-assistant-mk1-alert-id`. An unconfigured destination leaves durable alerts
visible for operators rather than discarding them.

The first-party receiver is
`POST /api/workbench/operator-alerts/ingest` on Vercel. It shares only the
server-side signing secret, rejects bodies over 64 KiB, verifies HMAC and a
ten-minute freshness window, and forwards redacted alert metadata to Sentry
with an alert-id fingerprint. It does not persist credentials or tenant scope.
Set the Worker webhook URL to this route and configure the same
`WORKBENCH_OPERATOR_ALERT_SIGNING_SECRET` in Vercel and the Worker.

## Data Portability

`POST /workbench/data-exports` creates the complete asynchronous D1/R2/Durable
Object export; the scoped status and private download routes expose it only
after checksum-backed publication. `GET /workbench/data-deletion-plan`
inventories retained data without deleting it. Workspace deletion is a separate
fresh-authenticated quarantine, recovery, and resumable purge contract; see
`docs/migrations-and-retention.md`.

Level 3 service-boundary conformance creates a real local R2 blob through the
Vercel facade, reads it back, verifies History metadata and a checksum-backed
asynchronous workspace export, shortens the retention policy, advances the
scheduled Worker, and proves the expired content is no longer readable.

## Tools And Policy

The current tool slice is read-only and Admin-triggered. Cloudflare exposes
`GET /tools`, `POST /tools/runs`, `POST /tools/policy`, and scoped approval
routes; Vercel facades live under `/api/workbench/tools`.

`url.inspect` is the first public-web read-only adapter. It runs in `dry_run`
mode, rejects local/private/metadata targets, performs bounded public HTTP
inspection, and stores Cloudflare-owned workflow/run/tool-call/artifact/audit/
event state. It can become model-visible only by explicit owner/admin policy
opt-in for the current user/workspace/agent permission row, and exposure stays
blocked when approval is required or the tool is disabled.

`repo.snapshot` is the first serious CLI/OSS-style read-only adapter. It is
dry-run only, Admin-visible by default, model-hidden unless explicitly enabled
by policy, and does not accept arbitrary shell commands or filesystem paths. It
runs through the signed runner boundary with a fixed sandbox contract:
ephemeral filesystem, no network egress, timeout, stdout/stderr limits,
redaction, and metadata-only artifact promotion. Its runner lifecycle is
callback-owned: the Fly gateway posts `run.started`, `artifact.created`, and
terminal callbacks, while `/tools/runs` remains synchronous-compatible for
Admin.

Admin conformance tools are intentionally product-safe probes:

- `diagnostic.ping`: Cloudflare-inline policy/run/tool/audit/event trace probe.
- `runner.echo`: signed Fly runner probe using the workflow callback lifecycle.
- `artifact.metadata.test`: Cloudflare-inline metadata artifact probe.

They are Admin-visible, model-hidden, dry-run-only, and not editable through
tool policy.

Admin summary `lastError` is recovery-aware. Historical failed runs and failed
events remain in history, but they stop pinning the global Details state after
a newer completed control run for the same workspace proves the path recovered.

Generic policy evaluates execution modes, approval state, model exposure, kill
switches, allowlists, denylists, cooldowns, hourly limits, max runtime, and max
artifact bytes. Approval-required `url.inspect` validates safe input, persists
an interrupted run and requested approval, then waits for Admin approve/deny.

## Trust Boundary

Vercel owns hosted web session resolution. Cloudflare owns membership, agent
access, session, thread, tool, and run ownership from trusted scope. Normal
facade requests may be signed with a shared server-side secret; Cloudflare
verifies signature metadata before trusting forwarded identity headers.

The facade must not expose Fly tokens, provider keys, tool credentials, or
tenant scope to the browser. Fly remains the heavy execution plane and reports
progress back through Cloudflare-owned state.
