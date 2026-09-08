# Operloom Architecture Overview Diagram

Last updated: 2026-06-25

## Purpose

Show the current hosted implementation topology of operloom after WorkOS,
Cloudflare Agent chat, workspace/agent routing, `/agents`, active-agent slash
actions, `/history`, read-only tools, pack workflows, callbacks, and
control-plane event visibility landed. This diagram is an overview only: it
should help a maintainer see the
active Vercel frontend, Cloudflare Worker control-plane slice, Fly
LangGraph/runtime executor, and durable data boundary without recreating every
detailed architecture view.

## Detail Level

Subsystem-level, implementation-guiding, not file-by-file. Major boxes should
represent real runtime seams, contracts, policy gates, storage responsibilities,
or trust boundaries. The canvas should be explicit enough for an implementing
agent to update adjacent docs or code without needing the old graph generator.

## Diagram Source

- Mermaid source: `docs/diagrams/current-implementation-topology.mmd`
- Canonical visual source: the Mermaid file
- Evidence source: this brief
- Visual artifact: paste the Mermaid source into Excalidraw's Mermaid import

## Source Evidence

- `docs/architecture.md`: system shape, control plane shape, seams, runtime
  boundaries, deployment boundary
- `docs/infrastructure.md`: infrastructure topology and request flow
- `docs/cloudflare-control-plane.md`: target live multi-user coordination plane
- `docs/fly-tool-runners.md`: target heavy tool and workflow execution plane
- `docs/dev-infrastructure-readiness.md`: current hosted WorkOS, Cloudflare D1,
  Vercel, and Fly runtime baseline
- `docs/data-and-state.md`: storage responsibilities and durable outputs
- `docs/db-contracts.md`: data-client boundary and durable entity contracts
- `docs/runtime.md`: LangGraph threads, runs, interrupts, crons, and external
  signals
- `lib/workbench/agent-identity.ts`: WorkOS/local-dev identity derivation and
  trusted headers sent from Vercel to Cloudflare
- `app/assistant.tsx`: frontend assistant-ui runtime integration seam
- `components/workbench/workbench-shell.tsx`: local commands for `/new`,
  `/agents`, active-agent slash actions, `/history`, `/admin`, and Admin
  dry-run probes
- `components/workbench/workbench-agents-panel.tsx`: compact agent picker and
  same-thread handoff confirmation
- `components/workbench/workbench-history-panel.tsx`: workbench history drawer
  for scoped runs, selected-run summaries, and metadata-only artifacts
- `components/workbench/workbench-runtime-hint.tsx`: compact runtime state and
  normal History/Admin entry points
- `lib/workbench/pack-workflow-bindings.ts`: frontend binding map from declared
  pack workflows to bounded dry-run request shapes and Vercel routes
- `app/api/workbench/chat-session/*`: Vercel facades that ask Cloudflare for
  the active chat session, recent threads, and Cloudflare-signed Agent token
- `app/api/[..._path]/route.ts`: legacy/transition Next.js proxy to LangGraph
  API for workflow escalation paths
- `app/api/external-signals/[publicId]/route.ts`: signed per-trigger webhook facade
- `app/api/workbench/*`: Vercel same-origin facades for workspace, agent, admin
  summary, chat runtime summary, workflow, history, and control-plane event routes
- `cloudflare/control-plane/src/index.ts`: Worker routing for WorkOS-shaped
  identity, workspace/agent APIs, chat facade, control events, runtime workflows,
  and signed run callbacks
- `cloudflare/control-plane/src/authz.ts`: D1-backed user, workspace,
  membership, active workspace, and active agent resolution
- `cloudflare/control-plane/src/chat-agent-connection-context.ts`: Worker
  helper that creates/resolves the active D1 thread for Agent chat
- `cloudflare/control-plane/src/chat-session.ts`: Worker session API that owns
  active thread selection, workspace history, and Agent token minting
- `cloudflare/control-plane/src/thread-chat-agent.ts`: Cloudflare
  `AIChatAgent` Durable Object chat runtime
- `cloudflare/control-plane/src/runtime-workflows.ts`: compiled Runtime Module
  workflow resolution, policy preflight, context construction, and execution
- `cloudflare/control-plane/src/runtime-run-lifecycle.ts`: atomic intent, run,
  tool-call, staged artifact, audit, event, cancellation, and terminal writes
- `cloudflare/control-plane/src/runtime-tool-execution.ts`: shared inline/Fly
  dispatcher used by workflows, Admin, approvals, and model-visible tools
- `cloudflare/control-plane/src/workbench-history.ts`: scoped execution and
  artifact history reads
- `cloudflare/control-plane/src/tool-policy.ts`: registered tool policy,
  execution-mode gates, model exposure, approvals, and constraints
- `cloudflare/control-plane/src/langgraph-facade.ts`: legacy Worker
  `/langgraph` compatibility facade and Fly fallback/proxy path
- `cloudflare/control-plane/schema.sql`: current D1 tables for users,
  workspaces, memberships, agents, active preferences, chat state, control
  events, runtime traces, runs, tools, artifacts, decisions, and audit records
- `scripts/langgraph-runtime-gateway.ts`: Fly runtime gateway, LangGraph proxy,
  and signed runner/executor endpoints
- `backend/agent.ts`: current LangGraph backend/provider seam
- `langgraph.json`: graph id mapping for local and hosted LangGraph execution

## Intended Diagram

Use four visibly separated pillars plus one sidecar cluster:

- `Vercel / Frontend`: Next.js app, WorkOS AuthKit session, assistant-ui
  thread, `/agents`, active-agent slash actions, `/history` local workbench
  surfaces, Agent connection route, pack webhook API, and workbench API
  facades.
- `Cloudflare / Worker Control Plane`: control-plane Worker, WorkOS scope
  resolver, workspace and agent authorization, `WorkbenchSessionAgent`,
  `WorkbenchThreadChatAgent`, workspace/agent/admin APIs, pack workflow routes,
  tool registry/policy, history/artifact APIs, session event stream, callback
  endpoint, runtime workflow kernel, and approval recovery APIs.
- `Fly.io / LangGraph Execution`: runtime gateway, LangGraph server,
  `backend/agent.ts`, and signed tool runner.
- `Durable Data Plane`: current D1 user/workspace/agent records, D1 chat state,
  D1 run/tool/artifact/audit records, Durable Object SQLite hot messages, plus
  current forward-only D1 migrations and planned R2/workflow checkpoints.
- `External sidecars`: external triggers, public read-only data sources, and
  OpenRouter provider. Keep this as one sidecar cluster, not a fifth pillar.

Typed arrow categories:

- `agent connection`: assistant-ui asks Vercel for a server-derived Agent
  connection; Vercel calls Cloudflare, then returns a short-lived token.
- `WebSocket chat`: assistant-ui talks directly to the Cloudflare `AIChatAgent`
  Durable Object for normal messages.
- `fallback/escalation proxy`: unsupported LangGraph-compatible endpoints and
  future heavy workflow escalation can still go through the Fly LangGraph
  gateway.
- `local command`: slash-command workbench surfaces open local panels before
  calling same-origin workbench facades.
- `trusted ingress`: external signals enter through the Vercel API route and
  create Cloudflare-owned typed intent/run state before any delegation.
- `workbench action`: Vercel workbench routes call the Cloudflare Worker with
  WorkOS-derived or local-dev trusted headers.
- `scope resolution`: Cloudflare resolves user, account, active workspace,
  membership, and active agent from trusted headers and D1.
- `signed runner dispatch`: Cloudflare dispatches runner-backed tools to the
  signed Fly boundary.
- `progress callback`: Fly runner reports run/tool/artifact events back to the
  Cloudflare callback endpoint.
- `canonical write`: Cloudflare writes user/workspace/agent, chat, run, tool,
  event, artifact, decision, and audit data to D1.
- `planned storage`: R2 artifact blobs, retention automation, and workflow
  checkpoints are shown as planned responsibilities, not current durable
  implementation. D1 migrations are a current data-plane responsibility.

## Visual Rules

- Draw current hosted implementation only; put north-star production topology in
  `docs/diagrams/north-star-implementation-topology.mmd`.
- Use exactly four primary pillars: Vercel/frontend, Cloudflare/Worker, Fly.io
  LangGraph execution, and durable data.
- Keep external providers and triggers in one sidecar cluster.
- Keep text short enough to read when zoomed out.
- Use concrete repo/runtime names.
- Keep source/evidence detail in this brief, not as dense canvas text.
- Keep Mermaid node labels short enough to survive Excalidraw import.
- Do not add generated Markdown, generated HTML, or a TypeScript graph pipeline.
- Route storage writes into the data pillar.
- Do not draw any Fly-to-browser source-of-truth path.

## Acceptance Checklist

- The Mermaid source exists at `docs/diagrams/current-implementation-topology.mmd`.
- The source contains one high-level topology, not seven detailed views.
- The source has exactly four primary pillars and no more than one sidecar
  cluster.
- Vercel/frontend, Cloudflare/Worker, Fly.io LangGraph execution, and durable
  data are visually separated.
- All required systems listed in this brief appear in the Mermaid topology.
- Directional relationships are represented by typed Mermaid edges.
- Every arrow maps to one typed arrow category listed in this brief.
- Cloudflare remains the current canonical owner for workspace, agent, chat,
  event, tool, workflow, history, and artifact state.
- Data writes route into the durable data pillar.
- The Mermaid source can be pasted into Excalidraw for a manual editable
  rendering.
