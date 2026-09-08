# ADR-0007: Cloudflare Agents Live Chat Runtime

Status: accepted

Date: 2026-06-11

## Context

Operloom started from an assistant-ui LangGraph starter. That was useful
for proving thread streaming quickly, but the measured hosted path made normal
chat do too much D1 and facade work before the first token. It also kept the UI
shaped around a LangGraph-compatible API even though small chat should not hit
Fly/LangGraph.

The north star is:

- WorkOS and Vercel own web authentication/session handling.
- Cloudflare owns app authorization, workspace/agent selection, policy,
  control-plane state, Admin summaries, tools, traces, audit, and artifacts.
- Durable Objects own live, hot, per-thread chat state.
- Fly/LangGraph handles explicit heavy workflows and tool runners, not normal
  small chat.

## Decision

Normal hosted chat uses Cloudflare Agents. Each resolved chat thread maps to one
`WorkbenchThreadChatAgent` Durable Object extending `AIChatAgent`.

The browser does not provide trusted tenant, workspace, agent, or thread scope.
Instead:

1. Vercel derives WorkOS/local identity server-side.
2. Vercel calls Cloudflare to resolve authorization for the active workspace
   and user.
3. Cloudflare dispatches to a user/workspace session coordinator Durable
   Object, which owns the hot active session/thread snapshot and mints a
   short-lived signed Agent connection token.
4. The browser connects to the per-thread Cloudflare Agent with that token.
5. The Agent verifies token scope, resolves D1 agent runtime config and
   behavior, streams OpenRouter, persists hot messages in Durable Object
   SQLite, and mirrors compact run/trace metadata to D1.

The latency-sensitive message path should not serially perform all
control-plane writes before contacting the model provider. The Agent may cache
active runtime/behavior config in its Durable Object instance for the lifetime
of the short-lived signed connection token. On each message, the required
pre-provider D1 work is the minimal run-start mirror batch. Completion mirrors,
trace details, and thread-touch updates can run after streaming starts or as
best-effort background work when they are not required for correctness.

## Consequences

- Normal chat should show `runtime = cloudflare-agent-chat`.
- Durable Object SQLite is the live transcript store for active thread chat.
- D1 remains the product/control-plane source of truth, not the full live
  transcript store.
- D1 is still on the critical path for scoped context and minimal run-start
  visibility, but serial D1 writes before first token are an implementation
  smell.
- Admin trace graphs can show `Cloudflare Agent`, `Durable Object`, `D1`, and
  `OpenRouter` as distinct latency surfaces.
- The old `/langgraph` simple-chat path becomes transition/compatibility code,
  not the intended normal chat path.
- Thread history is workspace-scoped D1 control-plane state layered over
  per-thread Agent Durable Objects.
- A user/workspace session coordinator keeps active-thread switching and token
  refresh fast without making D1 any less authoritative.

## Deferred

- Workspace-level Agent coordinator for schedules, wakeups, and run routing.
- Model-visible tools inside chat.
- Policy-backed tool exposure and approvals.
- Customer-facing agent builder and prompt editing.
- Full prompt/version approval workflow.
- Heavy Fly/LangGraph workflow escalation from the Agent.
