# Infrastructure

Operloom infrastructure should support many agent apps without making any
reference app the product shape.

Document status: this page describes active ownership and request flow. Use
`docs/deployment-railway.md`, `docs/deployment-vercel.md`, `docs/deployment-fly.md`, and
`docs/dev-infrastructure-readiness.md` as operational runbooks.

## Ownership

- Web provider: Next.js frontend, WorkOS AuthKit session, same-origin API facades,
  and browser ergonomics.
- Cloudflare: authorization, user/workspace/agent resolution, normal chat
  coordination, D1 control-plane state, Durable Object session state, tool
  policy, runtime summaries, events, and traces.
- Fly/LangGraph: graph-shaped workflows, signed server-side executors, heavy
  tools, and Linux-container work.
- Sentry: sampled external errors and performance telemetry. Product/runtime
  truth still starts from Cloudflare-owned D1 records and Admin summaries.

## Current Hosted Flow

```txt
browser
  -> Next.js web app
  -> WorkOS AuthKit session via Next SDK
  -> web facade derives trusted user/account identity
  -> Cloudflare resolves user, workspace, membership, active agent, and thread
  -> WorkbenchSessionAgent returns session snapshot and Agent connection token
  -> WorkbenchThreadChatAgent streams normal chat through OpenRouter
```

For `/new` and old-thread activation, Cloudflare returns the minimal active
thread/agent/connection payload first, then refreshes recent-thread state in
the background. Browser cache is display-only; D1 and Durable Objects remain
authoritative.

After the first session load, the browser should prefer the scoped
`GET /chat/session/stream` event source over broad polling. The stream carries
session snapshots, thread changes, chat run lifecycle, Admin tool updates,
trace updates, and Admin invalidation hints. Payloads must stay redacted.

## Escalation Flow

Normal chat should have `runtime = cloudflare-agent-chat`. Fly/LangGraph is
reserved for explicit workflow or heavy-tool escalation:

```txt
Cloudflare policy/router
  -> typed workflow intent or tool invocation
  -> run/control records in D1
  -> Fly LangGraph workflow or signed tool runner
  -> scoped Cloudflare callbacks
  -> D1 audit/artifact/decision/event state
  -> workbench stream/Admin visibility
```

Fly and LangGraph should read or write product state through mediated,
tenant-scoped Cloudflare APIs first. Direct D1/R2 access is a future
optimization only for measured hot paths and must preserve the same scoped
data-client, authz, redaction, and audit rules.

## Request Responsibilities

1. The web facade derives WorkOS user/account identity from the server session, or a
   trusted trigger supplies equivalent metadata.
2. Cloudflare resolves internal user, account, workspace, membership, and
   active agent.
3. Policy checks membership, agent access, tool permissions, execution mode,
   approvals, limits, and kill switches.
4. The runtime either answers through Cloudflare Agents or creates a typed
   workflow/tool run.
5. Executed work writes scoped results back as run records, tool calls,
   artifacts, decision records, audit events, traces, and lifecycle events.
6. Cloudflare streams product/runtime state to the frontend from canonical
   state.

## Storage

- Durable Object state / Durable Object SQLite: hot session and per-thread chat
  state.
- D1: users, workspaces, memberships, agents, preferences, chat/control run
  envelopes, tool permissions, approvals, audit events, traces, and events.
- R2: bounded artifact bodies such as logs, screenshots, reports, exports, and
  research bundles, mediated through tenant-scoped Cloudflare APIs. Hosted
  provisioning and recovery evidence remain release gates.
- LangGraph runtime storage: workflow-engine state for graph-shaped execution,
  not product authorization truth.

Canonical durable entity contracts are in `docs/db-contracts.md`.

## Observability

Use one Sentry project for the product and filter by `runtime.surface`:

- `next-web`
- `cloudflare-worker`
- `fly-langgraph`

Keep production tracing sampled. Admin/D1 runtime summaries answer product
state questions; unresolved Sentry issues are code/runtime failures.

## Reference App Boundary

Polymancer, deployment agents, and the Personal Job Agent are stress tests for
market workflows, operations, browser automation, secrets, ledgers, triggers,
and autonomy. They should pressure the framework without redefining the base
tenant model or adding a committed `Project` entity.
