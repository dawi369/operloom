# Runtime Model

The runtime is split into a conversational control plane and workflow execution plane.

The conversational agent handles fast user interaction: answering from notes/state, explaining current plans, editing memory, inspecting recent activity, and deciding whether a typed workflow intent is needed.

The workflow plane handles explicit multi-step work: tool calls, approvals, execution policy gates, background checks, and durable audit outputs. LangGraph is the preferred engine for complex workflows, but it is not the only possible backend.

assistant-ui remains the UI/runtime substrate for the thread, composer,
messages, stream ergonomics, attachments, and tool-call rendering where those
primitives fit. Operloom owns product-level runtime concepts around that
substrate: tenant scope, policy, durable run control, ledgers, managed state,
decision records, and external triggers.

## Workflow Lifecycle

Generic workflow stages:

- `observe`: collect state, events, inputs, or external data.
- `analyze`: compare evidence, reason about options, and update conviction.
- `propose`: create an action proposal, plan, or recommendation.
- `execute`: perform an approved action or dry-run execution.
- `review`: inspect results, update managed state, and write decision records.

Examples:

- Polymancer: observe markets, analyze conviction, propose trade, execute order, review position.
- Deployment agent: observe CI, analyze failure, propose fix, execute deploy, review logs.

## Threads

A thread is the persistent container for a conversation or task. The frontend
currently connects normal chat to a Cloudflare `AIChatAgent` Durable Object for
the active Cloudflare-owned thread. Durable Object SQLite owns hot per-thread
message state. D1 owns the product/control-plane thread record, active thread
selection, Admin summaries, traces, audit, tools, and future managed state.
Long-running workflows should store their continuity in a thread rather than
relying on browser state.

A user/workspace session coordinator Durable Object sits in front of the
per-thread chat Agents. It caches the current session snapshot, recent thread
summaries, active thread, active agent, and signed Agent connection payload for
one user in one workspace. D1 remains canonical and can rebuild the coordinator
after hibernation, but `/new`, thread switching, and token refresh should not
force the normal UI through the full Admin/session summary path.

The session coordinator is also the first live product-state stream. The
browser subscribes once to Cloudflare `GET /chat/session/stream` through the
Vercel facade and receives compact `session.*`, `chat.run.*`, `tool.run.*`,
`trace.updated`, and `admin.summary.invalidated` events. These events are
delivery hints over canonical D1/Durable Object state; they never contain
tokens, prompts, secrets, raw provider payloads, full tool output, or trusted
tenant scope.

Replayable Visibility v0 keeps that live session stream optimized for client
reconciliation and records durable lifecycle facts separately in
`control_plane_events`. Thread create, activate, rename, archive, restore,
delete, and blocked lifecycle attempts should be replayable from the
Cloudflare event feed for Admin/history reconstruction. Those durable events
are compact, scoped, redacted facts; they are not full session snapshots.

The browser may keep a display-only session shell for UX: recent thread
summaries, active thread id, active workspace label, active agent label/profile,
model id, and last known coordinator revision. That cache must never contain
signed Agent tokens, WorkOS data, secrets, behavior prompt text, or trusted
tenant scope. Cloudflare still owns thread activation and token minting; cached
browser data only prevents the shell/sidebar from blanking while Cloudflare
refreshes the authoritative session.

Thread create and switch should return a minimal active-thread response first:
selected thread, restored agent, signed Agent connection, revision, and a flag
that full thread history should refresh in the background. Explicit
`refresh=threads` reloads the full workspace recent-thread list from D1.

Future Fly/LangGraph progress should follow the same live path: the executor
calls a scoped Cloudflare callback, Cloudflare updates D1 run/event/artifact
state, the user/workspace coordinator broadcasts a compact session event, and
the browser updates from that stream. Fly should not own browser-facing
progress transport.

Normal chat should optimize for first token. The current Cloudflare Agent send
path trusts the short-lived scoped Agent token, uses per-Durable-Object cached
runtime/behavior config when available, writes one minimal D1 run-start mirror,
and starts OpenRouter before non-critical completion/event/trace-detail writes.
D1 stays authoritative for product/control-plane truth; Durable Object SQLite
stays authoritative for hot live transcript state.

## Runs

A run executes an assistant against a thread. Foreground chat and background work both map to runs. When multiple signals arrive for the same thread, use explicit multitask behavior such as enqueueing rather than racing new work.

In the target architecture, a run is a first-class control-plane record, not
only a workflow-engine implementation detail. A `RunRecord` should connect the
thread, optional workflow intent, execution policy, current status, heartbeat,
interrupt state, external engine run ID, and durable outputs such as tool calls,
artifacts, ledgers, audit events, and decision records.

Run status should be inspectable by the workbench UI. The user should be able to
answer: what is running, what is waiting, what failed, what can be cancelled,
and what durable evidence was produced.

## Child Runs

Delegated or subagent work should become child runs instead of invisible nested
model calls.

Child run rules:

- Child runs inherit trusted tenant scope from the parent runtime.
- Child runs link to `parentRunId` and `rootRunId`.
- Child runs receive a narrowed model-visible tool surface.
- Child run depth is capped by policy/runtime configuration.
- Parent cancellation can cascade to non-durable child runs.
- Durable child runs may outlive the parent only when policy explicitly allows
  it.
- Child results should return as structured summaries plus durable outputs, not
  only prose in the parent transcript.

Current child-run inspection v0 applies this contract to control-plane
`url.inspect` runs without adding autonomous subagents. Direct child runs store
`relation.parentRunId`, `relation.rootRunId`, `relation.depth`, and
`relation.durableChild` inside existing JSON data, Admin run snapshots list
direct children, and explicit nesting beyond depth `1` is blocked.

## Interrupts

Interrupts pause execution and wait for human or external input. They are the correct primitive for approvals, blocked decisions, missing credentials, and user confirmation.

Important rule: code before an interrupt can execute again when resumed. Side effects before interrupts must be idempotent, or they should move after the interrupt.

## Tool Exposure

Tool registration and tool exposure are separate concerns. The platform may know
about many tools, but a given model run should see only the tools allowed for
its tenant scope, agent, workflow stage, execution mode, policy, and child-run
context.

Runtime Module v1 is the executable tool contract. The compiler supplies the
active pack catalog; `runtime-tool-execution.ts` applies scoped policy, schema,
connection, limit, and inline/Fly dispatch decisions for workflow, model, and
Admin surfaces. Registration never implies model exposure.

## Lifecycle Events

Runtime behavior should emit typed lifecycle events before operloom adds
any user-installed hook system.

The canonical event vocabulary is documented in
`docs/observability-and-audit.md` and backed by `LifecycleEventName` in
`lib/workbench/core-contracts.ts`. These events feed audit logs, UI timelines,
policy checks, and future extension points. Arbitrary filesystem hooks are not
part of the first implementation.

## Crons

Recurring starts are retained Cloudflare trigger records bound to an exact
installed Agent Pack snapshot, trigger declaration, workflow binding, tenant,
and active agent. Cloudflare's scheduled handler scans due records, coalesces
the scheduled occurrence into an idempotency key, creates a dispatch, obtains a
bounded lease, and invokes the registered read-only workflow. Every invocation
creates the same typed intent/run/audit/event records used by foreground work.

Schedules are disabled until an authorized operator explicitly creates and
enables them in Admin. Cron expressions and IANA timezones come from the trusted
pack declaration. Pausing or disabling a trigger prevents new leases; disabling
also revokes active linked runs. Expired leases are recovered by the scheduler.

## External Signals

Agent Pack webhook triggers use `POST /api/external-signals/:publicId`. Creating
the trigger returns a one-time secret. Vercel signs the complete facade request
to Cloudflare; Cloudflare verifies both the facade signature and the stored
per-trigger secret hash. The retained trigger supplies tenant, agent, pack, and
workflow identity. The external caller cannot select any of them.

Authentication:

```http
Authorization: Bearer <one-time-trigger-secret>
Idempotency-Key: provider-event-id
```

Deliver a declared trigger payload:

```json
{
  "repositoryPath": "."
}
```

Duplicate idempotency keys return the original dispatch. Payload size and the
pack workflow input schema are checked before durable acceptance. The unscoped
legacy `/api/external-signals` endpoint returns `410` and cannot start work.

## Persistence

Local development may use the LangGraph dev server's default behavior for
workflow-engine testing. Hosted normal chat should not rely on Fly Machine or
LangGraph dev-server memory. It is Cloudflare Agent-owned for live message
state and scoped through D1 for product/control-plane truth. Hosted workflow
escalation must still verify whether interrupted LangGraph work survives
restart before relying on it.

Production persistence should separate concerns:

- Tenant-scoped relational state for users, workspaces, permissions, ledgers, triggers, audit events, and decision records.
- Per-agent hot state for live conversation/session coordination.
- Object storage for artifacts, logs, traces, reports, and screenshots.
- Workflow engine state for in-flight complex workflows.

See `docs/data-and-state.md` for storage ownership and `docs/infrastructure.md` for the target control-plane/request flow.
