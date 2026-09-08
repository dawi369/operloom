# North-Star Production Architecture Diagram

Last updated: 2026-06-06

## Purpose

Show the finished production shape operloom is aiming at: a web-first,
multi-user, tenant-scoped agent workbench where Vercel owns the WorkOS-backed
frontend session, Cloudflare owns authorization, live coordination, and
canonical app-state mediation, Fly owns heavy execution, and all durable outputs
return to auditable state.

This is a north-star product graph, not the current implementation map. It should
make the target ownership boundaries clear enough that future implementation
plans can be checked against it.

## Detail Level

Subsystem-level, implementation-guiding, not file-by-file. Major boxes should
represent real product subsystems, runtime boundaries, policy gates, contracts,
state stores, or external mutation boundaries. The canvas should be explicit
enough for an implementing agent to reason about ownership and handoffs without
adding dense prose to the drawing.

## Diagram Source

- Mermaid source: `docs/diagrams/north-star-implementation-topology.mmd`
- Canonical visual source: the Mermaid file
- Evidence source: this brief
- Visual artifact: paste the Mermaid source into Excalidraw's Mermaid import

## Source Evidence

- `docs/architecture.md`: target control plane, workflow execution plane, policy,
  and canonical state shape
- `docs/runtime.md`: conversational control plane, workflow plane, runs, child
  runs, interrupts, crons, external signals, and persistence
- `docs/cloudflare-control-plane.md`: Cloudflare ownership of live coordination,
  tenant scope, policy, mediated data APIs, D1/R2/DO state
- `docs/fly-tool-runners.md`: Fly as heavy execution plane and signed
  tenant-scoped tool boundary
- `docs/data-and-state.md`: durable entity ownership, D1/R2/workflow backend
  responsibilities, mediated data-client access pattern
- `docs/policy-model.md`: deterministic policy boundary, execution modes,
  approval gates, production mutation gate, and failure behavior
- `docs/secrets-and-risk.md`: encrypted, scoped, revocable secret custody and
  production mutation gates
- `docs/db-contracts.md`: durable entity contracts and data-client boundary
- `docs/observability-and-audit.md`: lifecycle events, audit trail, artifacts,
  and health responsibilities

## Intended Diagram

Use four visibly separated pillars plus one sidecar cluster:

- `Vercel / Frontend`: WorkOS AuthKit session, operator cockpit, thread
  surface, approvals, run/status panels, artifacts view, and same-origin
  server facade.
- `Cloudflare / Worker Control Plane`: trusted Vercel and trigger ingress,
  tenant scope resolution, membership and agent authorization, intent router,
  policy plus tool exposure, run control, streaming gateway, and mediated data
  API.
- `Fly.io / LangGraph Execution`: signed tool gateway, tool runners, browser
  automation, LangGraph workflow workers, and progress callbacks.
- `Durable Data Plane`: D1 control records, D1 audit and ledgers, R2 artifacts,
  Durable Object hot state, workflow checkpoints, and encrypted secret custody.
- `External sidecars`: schedules/webhooks, model providers, approved APIs/tools,
  and mutation targets. Keep this as one sidecar cluster, not a fifth pillar.

Typed arrow categories:

- `user interaction`: browser workbench sends chat, approval, status, and
  artifact requests through the Vercel server facade.
- `trusted identity`: Vercel derives WorkOS user, organization, roles, and
  permissions from the server session before calling Cloudflare.
- `trusted scope`: Cloudflare resolves tenant scope, membership, and active
  agent from trusted Vercel context, schedule, webhook, or tool-event context.
- `intent routing`: chat or external events become typed workflow intents only
  when complex work is needed.
- `policy decision`: policy gates tool exposure, execution mode, approvals,
  secret access, mutation limits, and kill switches.
- `secret access`: secret reads are scoped, policy-gated, and mediated by
  Cloudflare-owned data APIs.
- `approval interrupt`: policy can pause a run until user approval resumes,
  cancels, or fails it.
- `signed work`: Cloudflare sends tenant-scoped signed work to Fly execution.
- `external call`: Fly calls model providers, approved APIs, automation targets,
  and mutation targets only after policy approval.
- `progress callback`: Fly reports status and final summaries back to
  Cloudflare, not directly to the browser as source of truth.
- `canonical write`: Cloudflare-mediated data-client writes run records, audit
  events, decisions, ledgers, managed state, tool calls, and artifacts.
- `stream update`: Cloudflare streams progress, approval state, status, and
  final results back to the browser-facing Vercel surface.

## Visual Rules

- Draw this as production target only; do not mix current starter/Fly-staging
  shortcuts into this diagram.
- Use exactly four primary pillars: Vercel/frontend, Cloudflare/Worker, Fly.io
  LangGraph execution, and durable data.
- Keep external providers, schedules, APIs, and mutation targets in one sidecar
  cluster.
- Show Vercel as the WorkOS session owner and Cloudflare as the authorization,
  control-plane, and canonical-state owner.
- Make Fly clearly execution-only, not the user-facing stream owner.
- Show tenant scope, intent routing, and policy before execution.
- Show durable state as the place final truth lands.
- Keep labels short and use brief text for detail.
- Keep Mermaid node labels short enough to survive Excalidraw import.
- Do not add generated Markdown, generated HTML, or a TypeScript graph pipeline.
- Use callout badges for invariants: WorkOS session stays at Vercel, tenant
  scope is derived, model never supplies scope, Cloudflare owns canonical
  writes, and Fly executes only.

## Acceptance Checklist

- The Mermaid source exists at
  `docs/diagrams/north-star-implementation-topology.mmd`.
- The source is separate from the current implementation topology source.
- The source has exactly four primary pillars and no more than one sidecar
  cluster.
- Vercel/frontend, Cloudflare/Worker, Fly.io LangGraph execution, and durable
  data are visually distinct.
- Tenant scope and policy appear before any execution path.
- Typed workflow intent routing appears before policy and run creation.
- Heavy execution goes through signed Fly services.
- Final durable outputs return to auditable canonical state.
- No Fly-to-browser source-of-truth path exists.
- Every arrow maps to one typed arrow category listed in this brief.
- The Mermaid source can be pasted into Excalidraw for a manual editable
  rendering.
