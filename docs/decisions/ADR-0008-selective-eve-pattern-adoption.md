# ADR-0008: Selective Eve Pattern Adoption

Status: accepted

Date: 2026-06-17

## Context

Vercel Eve is a filesystem-first framework for durable backend AI agents. Its
public beta docs validate several operloom product primitives: durable
sessions, typed tools, human approvals, resumable work, sandboxed execution,
schedules, subagents, and real-session evals.

Operloom already has its own hosted architecture:

- Vercel owns the WorkOS-backed browser session and same-origin frontend
  ergonomics.
- Cloudflare owns authorization, workspace/agent resolution, policy,
  control-plane state, normal chat coordination, audit, traces, and canonical
  product writes.
- Fly/LangGraph owns explicit heavy workflow and server-side tool execution.

The useful move is selective adaptation. Eve should pressure operloom's
contracts and operator experience, but it should not replace the current
control-plane boundary.

## Decision

Adopt selected Eve-inspired patterns where they strengthen operloom's own
architecture:

- Replayable event streams: durable stream and reconnect semantics should
  inform `WorkbenchSessionAgent` events, Admin timelines, and "what happened?"
  reconstruction.
- Dynamic capability resolution: tools, skills, and instructions should be
  resolved per tenant, agent, stage, execution mode, policy, and feature flag
  through explicit Cloudflare-owned decisions.
- Unified human-in-the-loop semantics: approvals, clarification requests,
  blocked credentials, and user confirmations should share the same mental
  model of parked work plus explicit resume.
- Sandbox lifecycle and network policy: future Fly runners should distinguish
  template bootstrap, per-session setup, persistent workspace state, egress
  policy, and artifact promotion.
- Connection auth brokering: future integration auth should distinguish app
  principals, user principals, token refresh, authorization-required events,
  tool filters, and approval ordering.
- Child-run and subagent inspection: delegated work should map to child
  `RunRecord` relationships, depth limits, narrowed tool exposure, and Admin
  visibility.
- Schedule dispatch ergonomics: future triggers should support root-owned
  schedules and local/dev dispatch without waiting for production cron.
- Real-session evals: evals should drive the same HTTP and runtime surfaces
  users hit, and assert on runs, tool calls, messages, approvals, and HITL
  behavior.

Sequence adoption with visibility first. The first implementation slice is
Replayable Visibility v0: persist compact session lifecycle facts into
Cloudflare-owned control-plane events while keeping live session SSE as the UI
reconciliation path.

The next adopted slice is Dynamic Capability Resolution v0. It keeps capability
decisions Cloudflare-owned and policy-backed, adds inspectable tool capability
decisions to `/tools`, and preserves the existing narrow execution surface.
Skills, instruction packs, feature-flagged tool families, and runtime-expanded
tool catalogs remain deferred.

Unified HITL Semantics v0 follows the same conservative pattern. Existing tool
approval requests now expose a generic `humanIntervention` summary for parked
work and approve/deny resume semantics, while the concrete approval endpoints
and D1 tables remain unchanged.

Sandbox Lifecycle And Network Policy v0 is implemented at the signed runner
boundary. Cloudflare attaches a compact `runner.sandbox` contract to tool
runner metadata and Fly invocation bodies, and the Fly gateway rejects missing
or incompatible `url.inspect` egress policy before network access. Persistent
sandboxes, workspace volumes, browser automation, and general artifact
promotion remain deferred.

Connection Auth Brokering v0 is metadata-only. Tool summaries and capability
decisions now expose `connectionAuth` posture so future tools can distinguish
app principals, user principals, connection-scoped tool filters, token refresh,
authorization-required events, and approval ordering. Current tools report
`not_required`; no OAuth, secret custody, or token refresh worker is added.

Child-Run/Subagent Inspection v0 is relation metadata only. Cloudflare
`url.inspect` control runs now persist a compact `relation` object in existing
JSON data, expose that relation in run/tool summaries, list direct child runs
from the existing Admin run snapshot, and block explicit control-run nesting
beyond depth `1`. Model-triggered tool runs may still carry their chat run as a
legacy external `parentRunId`, but this does not create an autonomous subagent
runtime or deeper orchestration tree.

Schedule Dispatch Ergonomics v0 stays on the existing token-protected
`/api/external-signals` ingress. It adds a `dispatch_schedule` action for
local/dev schedule wakeups and normalizes root-owned schedule metadata for both
cron creation and manual dispatch. This lets scheduled work exercise the same
LangGraph run path without adding Cloudflare trigger tables, production cron
ownership, or trigger UI in this slice.

This v0 compatibility slice was superseded by the retained Agent Pack trigger
runtime documented in `../level-3-conformance.md`. The unscoped endpoint now
returns `410`; schedules and webhooks are Cloudflare-owned, tenant-scoped, and
operator-managed.

Real-Session Eval Posture v0 is a manifest and verifier, not an eval platform.
`lib/workbench/real-session-evals.ts` defines which existing smoke commands
count as real-session eval suites and which durable assertions they cover:
messages, runs, threads, tool calls, approvals, HITL, events, and traces.
`pnpm eval:real-session-posture` verifies the manifest and package scripts.
Supporting contract checks can be listed, but they do not count as real-session
coverage until they drive the same HTTP/session/runtime surfaces users hit.

Agent/Profile Authoring Format v0 makes the current built-in behavior templates
explicitly authored metadata, not editable prompt storage. Templates expose
`authoring.kind`, `authoring.format`, `authoring.source`, and snapshot policy;
agent creation still copies the selected server-owned XML template into
`agents.data_json.behavior`. Filesystem loaders, user-authored profile packs,
template migrations, and browser prompt editing remain deferred.

## Rejected

- Eve as the core runtime for operloom.
- Vercel-owned durable agent state as the product source of truth.
- Running `npx eve@latest init .` or adding Eve dependencies to this repo.
- Broad built-in filesystem or bash tools as default model-visible
  capabilities.
- Pure path-derived production identity for agents, tools, schedules, policies,
  or audit records.
- Any model- or browser-supplied tenant scope.

## Consequences

- Eve is now accepted as a pattern reference, not an implementation dependency.
- Active implementation remains behind the WorkOS/Vercel -> Cloudflare ->
  Fly/LangGraph split.
- Filesystem-first authoring can be explored later as an authoring convention
  that compiles into explicit durable records, stable IDs, aliases, policy, and
  ownership metadata.
- Tool exposure must remain narrow, policy-gated, auditable, and redacted.
- Secrets stay out of app code, browser responses, model output, logs,
  artifacts, and sandbox state unless a specific redacted metadata surface
  requires them.
- Future Eve-inspired work should be scoped as concrete operloom gaps,
  not broad framework adoption.

## Deferred

- Filesystem template loader, user-authored profile packs, and browser prompt
  editor.
- Full integration-auth and secret-custody contract.
- Sandbox lifecycle implementation on Fly runners.
- Deeper child-run orchestration and autonomous subagent execution.
- Hosted unattended-operation evidence and operations runbook for the retained
  schedule/webhook runtime.
- LLM-judged eval framework, stored prompt corpus, and browser automation
  grading loop.
- Any Eve executor spike. If a real execution gap appears, Eve may be spiked
  only as a tenant-scoped executor behind Cloudflare callbacks, with
  Cloudflare still owning scope, run records, policy, audit, artifacts, and
  user-visible stream state.

## References

- Vercel Eve introduction: `https://vercel.com/docs/eve`
- Eve concepts: `https://vercel.com/docs/eve/concepts`
- Eve tools: `https://eve.dev/docs/tools`
- Eve sessions, runs, and streaming:
  `https://eve.dev/docs/concepts/sessions-runs-and-streaming`
- Eve sandbox: `https://eve.dev/docs/sandbox`
- Eve connections: `https://eve.dev/docs/connections`
- Eve subagents: `https://eve.dev/docs/subagents`
- Eve schedules: `https://eve.dev/docs/schedules`
- Eve skills: `https://eve.dev/docs/skills`
- Eve dynamic capabilities: `https://eve.dev/docs/guides/dynamic-capabilities`
- Eve human-in-the-loop: `https://eve.dev/docs/human-in-the-loop`
- Eve evals overview: `https://eve.dev/docs/evals/overview`
