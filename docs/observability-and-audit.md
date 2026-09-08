# Observability And Audit

Observability explains what the agent is doing now. Audit explains what
happened and why after the fact.

Both are product primitives for long-running agent work.

## Mandatory Runtime Signals

Every long-running or tool-using workflow should expose:

- run status
- workflow stage
- heartbeat freshness
- active tool call
- current interrupt or waiting reason
- failure summary
- cancellation availability
- latest durable outputs

The workbench UI should not need to parse model prose to show this state.

## Lifecycle Events

Lifecycle events are the first extension surface.

Replayable Visibility v0 persists compact lifecycle facts in Cloudflare
`control_plane_events` while keeping live session SSE as the UI reconciliation
path. The event feed is the replayable Admin/history surface; live SSE remains
a hint channel over canonical state.

Initial events:

- `intent.created`
- `run.queued`
- `run.started`
- `run.interrupted`
- `run.child.blocked`
- `approval.requested`
- `tool.requested`
- `tool.started`
- `tool.finished`
- `artifact.created`
- `decision.created`
- `run.completed`
- `run.failed`
- `run.cancelled`

Events should include scope, actor, run ID, workflow intent ID, target entity,
summary, timestamp, and redacted metadata.

## Audit Events

Audit events are append-only records for important platform, workflow, or tool
activity.

Audit these boundaries:

- external trigger accepted/rejected
- workflow intent created
- run started/completed/failed/cancelled
- interrupt requested/resumed/denied
- policy allowed/blocked
- tool requested/started/finished
- secret access granted/denied
- artifact created
- decision created/superseded
- ledger entry appended
- managed state patched

## Logs Vs Artifacts Vs Audit

- Logs: detailed execution output, often large, often redacted, stored as
  artifacts when useful.
- Artifacts: durable blobs or generated outputs with searchable metadata.
- Audit events: compact immutable facts about important actions.

Do not put huge logs into audit events. Do not rely on artifacts alone for
auditable state changes.

## Redaction

Redact before writing:

- provider keys
- OAuth tokens
- API tokens
- wallet/account credentials
- private user data not needed for the record
- raw prompts when they contain sensitive data
- raw tool output that includes secrets

Audit summaries should be safe for UI display.

## External Error Monitoring

Sentry is the first external exception and trace sink for operloom.
Cloudflare D1 remains the source of truth for product state, runtime summaries,
audit records, and "what happened?" answers; Sentry is for debugging runtime
failures, regressions, and cross-surface traces.

The current Sentry org/project is:

- Org: `t23`
- Project: `operloom`

Use one project for the Operloom product and distinguish runtime surfaces
with tags instead of creating separate projects too early:

- `runtime.surface=vercel-next` for the Vercel/Next web app and server facade.
- `runtime.surface=cloudflare-worker` for the Cloudflare control plane Worker.
- `runtime.surface=fly-langgraph` for the Fly/LangGraph gateway and workflow runtime.
- `runtime.surface=expo-native` for the iOS and Android operator app.

This keeps issues, releases, and traces in one product view while preserving
easy filters for the surfaces that fail differently. Add more tags when they
represent real operating boundaries, such as `runtime.target` or a non-sensitive
agent/runtime label. Do not send workspace or user identity, provider keys,
WorkOS secrets, model prompts containing private data, or raw tenant data to
Sentry.

All Sentry surfaces share the same fail-closed scrubber. It removes user
contexts, request bodies, cookies, authorization and signing headers, OAuth and
PKCE material, credential-shaped fields, and URL query strings from events and
breadcrumbs. `sendDefaultPii` remains disabled. The retained diagnostic
allowlist is release/environment, runtime surface, request ID, bounded error
code/status metadata, and redacted exception text. Verify this boundary with
`pnpm observability:check` after changing telemetry configuration.

Source maps should use `SENTRY_AUTH_TOKEN` only in trusted CI/deploy
environments. Never commit the auth token or print it in logs.

Native builds on the [mobile WIP branch](mobile-frontends.md) use `@sentry/react-native` with the same runtime-neutral scrubber
as web, Worker, and Fly. The public mobile binary may contain only the DSN,
environment, and full-SHA release. `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and
`SENTRY_PROJECT` are build-time EAS/local-build values and must never use the
`EXPO_PUBLIC_` prefix. The Sentry Metro configuration and Expo config plugin
upload JavaScript and native symbols for preview/release builds; Expo Go is not
a symbolication acceptance environment. A native build is accepted only when
its Sentry release equals the Git SHA in mobile device evidence.

Local Sentry transport is disabled by default even when `.env.local` contains
DSNs. Enable `SENTRY_ENABLE_LOCAL=true` for server/edge diagnostics and
`NEXT_PUBLIC_SENTRY_ENABLE_LOCAL=true` for browser diagnostics explicitly;
otherwise local reloads and deterministic E2E traffic stay out of hosted
error, trace, and replay quotas.

Production Sentry sampling should stay intentionally quiet:

- Production traces default to `0.02` across Vercel and Cloudflare.
- Local development sends no telemetry unless it is explicitly enabled.
- Browser replay is sampled only on errors in production by default.

Normal request transactions such as `GET /` can still appear under Sentry
traces when they are sampled. Treat those as performance telemetry, not runtime
errors. Unresolved issues remain the primary Sentry view for failures. Resolve
fixed probes and obsolete deployment failures promptly so this view stays
actionable. Production alert ownership belongs to the Sentry project owner:
new errors, five errors within five minutes, critical operator alerts, and
regressions on resolved issues must notify that owner. Operator alerts aggregate
by stable alert code rather than per-record identifiers.

## Runtime Traces

Runtime traces are first-party product telemetry stored in Cloudflare D1. They
exist so Admin can answer "what exactly happened?" without digging through
Vercel, Cloudflare, or Sentry logs.

The v0 trace model is:

```txt
RuntimeTrace
  -> RuntimeSpan[]
```

Each span records a compact, redacted step with:

- trace id, span id, and optional parent span id
- layer: browser, Vercel, Cloudflare, Durable Object, D1, provider, executor,
  or tool
- start, end, duration, and status
- small operational metadata only

Do not store prompts, provider request bodies, auth headers, secrets, full tool
outputs, or raw private data in trace payloads. Large outputs belong in
artifacts. Sensitive failures belong in redacted error summaries plus Sentry
exceptions when useful.

Current traced operations:

- `chat.thread.create`
- `chat.agent.stream`
- `chat.run.stream`
- `tool.url.inspect`, including redacted runner dispatch metadata for
  transport, adapter version, source, duration, status, response status, and
  failure code
- runtime-module workflow and tool traces, keyed by compiled pack and binding
  metadata rather than tool-specific gateway branches

Admin uses these D1 traces as the primary in-app request explanation: service
map, waterfall, total duration, and bottleneck span. Sentry remains the
external sampled error/performance system.

## Health And Heartbeats

Health endpoint checks should distinguish:

- web server is up
- LangGraph/Fly execution path is reachable
- data-client backing store is reachable
- artifact store is reachable
- recent run heartbeat is fresh

The current `/api/health` is intentionally lightweight. Production health must
be broader before relying on unattended execution.

## "What Happened?" Query

The agent should answer "what happened?" from:

- run records
- audit events
- tool calls
- artifacts
- ledger entries
- decision records
- managed state changes

The answer should include provenance and freshness. If the durable records are
missing, the answer should say that rather than inventing history.

## Acceptance Criteria

- A completed run can be reconstructed from durable records.
- A failed run has a user-safe failure summary and deeper redacted artifacts
  where needed.
- Policy blocks and approvals are visible in audit history.
- Tool logs are stored as artifacts, not embedded in relational records.
