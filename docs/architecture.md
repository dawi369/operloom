# Architecture

Operloom is a reusable agent workbench with a conversational control
plane, a heavy execution plane, and hosted environments split across a Next.js web host,
Cloudflare, and Fly.

The architecture should support personal operation, developer distribution,
and business integrations without forking the core runtime. Customer- or
domain-specific behavior belongs in workspace, agent, policy, tool, context,
and integration configuration, not in hard-coded product assumptions.

The cumulative autonomy levels and guarantees expected from those subsystems
are defined in `capability-model.md`.

Document status: this page is the concise current system map. Use
`docs/infrastructure.md` for request flow and ownership, and
`docs/cloudflare-control-plane.md` for Worker/D1 details.

## System Shape

- Next.js App Router serves the frontend and same-origin API facades.
- WorkOS AuthKit runs at the Next.js web boundary.
- The web facade derives trusted WorkOS/local identity before calling Cloudflare.
- assistant-ui renders the thread, composer, messages, reasoning, tools, and
  attachments.
- Cloudflare resolves authorization, workspace, active agent, active thread,
  normal chat coordination, Admin summaries, runtime events, and control-plane
  state.
- Cloudflare Agents own normal hosted chat through a per-thread
  `WorkbenchThreadChatAgent` Durable Object.
- `WorkbenchSessionAgent` owns hot user/workspace session snapshots, thread
  switching, Agent connection payloads, and live-session events.
- Durable Object SQLite owns hot per-thread messages; D1 mirrors compact
  product/control-plane state for authorization and Admin visibility.
- Fly/LangGraph remain the explicit heavy workflow and server-side tool
  execution plane.
- OpenRouter is configured server-side for Cloudflare Agent chat and the
  Fly/LangGraph runtime.

The browser is the supported product client in `0.5.1`; the Expo app
is WIP on `codex/mobile-wip`, outside the web release. Shared clients use the
runtime-validated `@operloom/workbench-client` contract, while cookie auth
and Cloudflare Agent React remain web adapters. The native boundary is specified
in `docs/mobile-frontends.md`; native clients never receive the web facade
signing secret or bypass Cloudflare authorization.

## Control Plane Model

The core runtime model is:

```txt
trusted identity -> workspace/member/agent resolution
  -> policy and tool exposure
  -> chat, typed workflow intent, or tool run
  -> run/control records
  -> audit, artifacts, decisions, traces, and events
```

Normal chat stays on Cloudflare Agents. Complex workflows should be represented
as typed intents and escalated to Fly/LangGraph only when graph semantics,
container execution, browser automation, or heavy tools are needed.

The generic workflow lifecycle remains:

```txt
observe -> analyze -> propose -> execute -> review
```

## Generic Subsystems

- Identity and tenancy: every durable read/write is scoped to a user,
  workspace, membership, and agent resolved from trusted server context.
- Tool registry and exposure: installed tools can be broader than the
  model-visible set; exposure is resolved by policy, agent, stage, execution
  mode, and approval state.
- Server-side execution: browser code can request, approve, and inspect tools,
  but secrets and tool credentials stay server-side.
- Run control: foreground/workflow runs and read-only trigger dispatches track
  cancellation, retry/replay, leases, heartbeats, concurrency, and recovery as
  durable state. Delegated parent/child execution remains a target capability.
- Canonical state: outputs return as scoped decision records, managed state,
  artifacts, audit events, traces, UI events, immutable action proposals, and
  append-only action-ledger entries.
- Observability: Admin and D1 runtime summaries are product truth; Sentry and
  external tracing are downstream visibility layers.

## Important Seams

- `app/assistant.tsx`: assistant-ui runtime bridge to Cloudflare Agents.
- `lib/workbench/use-agent-connection.tsx`: loads the Cloudflare-owned session
  and active Agent connection.
- `components/assistant-ui/*`: reusable assistant-ui components.
- `components/workbench/*`: product-specific shell, sidebar, runtime hints, and
  Admin surfaces.
- `app/api/[..._path]/route.ts`: LangGraph API proxy.
- `app/api/workbench/*`: same-origin web facades over Cloudflare.
- `cloudflare/control-plane/src/connection-broker.ts`: tenant-scoped WorkOS
  Vault metadata, OAuth/API-key authorization, refresh/revoke/health, and
  provider-host-scoped request capabilities.
- `cloudflare/control-plane/src/action-authority.ts`: durable proposals,
  policy/approval rechecks, kill switches, execution CAS, terminal ledger, and
  ambiguous-outcome reconciliation.
- `cloudflare/control-plane/src/workspace-data-lifecycle.ts`: asynchronous
  D1/R2/DO export plus workspace quarantine, recovery, and purge.
- `app/api/external-signals/[publicId]/route.ts`: signed public facade for
  per-trigger Agent Pack webhooks. Tenant scope comes from the retained trigger,
  never the caller.
- `backend/agent.ts`: LangGraph graph/provider seam.
- `cloudflare/control-plane/*`: Worker, D1 schema/migrations, Durable Object
  Agents, authz, policy, chat, tools, events, traces, and the canonical
  schedule/monitor/webhook trigger runtime.
- `workbench.config.ts`: the only manual registry for trusted build-time Agent
  Runtime packages.
- `packages/agent-sdk/*`: Pack API v2 and Runtime Module v1 public contracts.
- `generated/agent-runtime/*`: deterministic manifest, Cloudflare, runner, web,
  conformance, and compiled-workbench-version registries.
- `cloudflare/control-plane/src/runtime-workflows.ts`: the sole package workflow
  kernel for schema/resource checks, scoped execution, CAS state, and response
  formatting.
- `cloudflare/control-plane/src/runtime-tool-execution.ts`: the shared inline/Fly
  dispatcher used by workflows, model tools, and pack-backed Admin tools.
- `cloudflare/control-plane/src/runtime-run-lifecycle.ts`: atomic D1 start,
  promotion, terminal publication, trigger completion, and cancellation boundary.
- `examples/complex-operator/*`: provider-free external-style extension proof.

## Deployment Boundary

Local development normally runs the Next app and LangGraph server with:

```bash
pnpm dev
```

The hosted dev baseline is:

```txt
Browser -> Next.js web app (Railway for the maintained demo; Vercel optional)
        -> WorkOS AuthKit session
        -> web API facade
        -> Cloudflare Worker/D1 for authz, chat/session, and control state
        -> Cloudflare Agents for normal messages
        -> Fly/LangGraph only for explicit heavy execution
```

The configured web provider owns hosted sign-in and browser ergonomics. Cloudflare is the
authorization, control-plane, chat coordination, and canonical-state boundary.
Fly remains the execution plane.
