# Architecture

## Runtime evolution (experimental)

The v2 simulation action port uses the typed-state transaction for state, immutable
decisions/effects and delivery receipts. The server selects the simulation scope
and rechecks tool policy, evidence and attempt authority in the transaction.
External proposal/dispatch rejects simulation bindings. No additional service or
table is needed; see [simulation contracts](runtime-simulation.md).

The opt-in `/v1` Worker facade accepts WorkOS bearer tokens and dispatches through
the same authorization and command handlers as the signed Next facade. Command
targets carry explicit workspace and agent identities; caller identity headers
are discarded. The pure verifier is shared with native clients.

Typed-state commits extend D1 with scoped records, declared equality indexes,
receipts, immutable evidence and outbox intents. All mutations share one batch
with database-enforced preconditions. See [state design](runtime-state-design.md).
Operator reads and failed-event retry use the same backend authority, with shared
OpenAPI/Fetch schemas. Retry is conditional on observed attempts and commits its
audit event in the same D1 batch; simulation/external state targets stay separate.
Schema migrations pin declarative plans in D1 and advance through bounded,
transactional batches with persistent writer fences, cursors and replay receipts.
Authorized partial repair retains both reviewed plans and replaces only the
unprocessed suffix under the same revision guard and write fence.
Server-owned agent execution revisions are pinned in authenticated identities and
signed chat claims. D1 checks the pin at run admission/resumption; typed-state
ports check it on reads and commits. Revision changes reject active work. This
now supports explicit idle-agent package upgrades with immutable snapshots,
state/index validation and atomic receipts/audit; see [upgrade design](package-upgrades.md). Pending HTTP
chat commands now register in D1 before acknowledgement and pin the same revision.
Run admission atomically links a command to one run, and terminal outcomes publish
durable events. Deadline recovery closes abandoned work without re-executing it.
See [chat admission](chat-command-admission.md) for the cross-store failure model.
Opt-in v2 context resolvers receive immutable scope/input, read-only typed state
and cancellation. Schema-validated evidence and run linkage commit atomically in
D1 under current authority. Chat and workflows use the same collector; required
stale evidence blocks work, and typed commits recheck expiry atomically. Trust
comes from manifest declarations. See [scoped context](runtime-context.md).
Workflow structured model calls use the configured OpenRouter model and schema
validation, with no automatic provider retry. D1 atomically admits model/tool
reservations against workspace and canonical root-run budgets. Chat follow-up
steps use the same admission boundary. Settlement and its durable event share a
transaction; failed/ambiguous settlement retains the original charge. Evidence
configuration hashes include the effective model settings. See [models and budgets](runtime-models-and-budgets.md).
The internal durable-execution kernel now records atomic submission/run identity,
immutable pins, named step attempts and validated outcome receipts in D1. Safe
retry is explicit and bounded; unknown unsafe attempts cannot redispatch. Its
tables join export and purge. State/context publication and model/tool admission
now enforce active step-attempt authority inside D1 transactions; incurred usage
can settle afterward without granting new authority. The gated native Workflows
adapter now supplies v2 steps, timer waits and `202` submission. A leased D1
reconciler inspects bounded engine batches, recovers pending starts, closes expired/
revoked/failed work atomically and terminates cancelled instances. Unknown step
outcomes remain inspectable; started instances are never recreated automatically.
It caches opaque result references, with inputs/results retained in D1.
Native creation dispatches have scoped acknowledgement receipts. Workspace purge
confirms native deletion in bounded batches before D1 identities can be removed;
unsettled or ambiguous creation outcomes preserve a reconciliation fence.
Durable steps now have separate immutable context captures and ordered revisions;
new steps refresh evidence after waits, while retries retain the same capture.
Clients page capture metadata and fetch evidence by ID. Approval pauses bind immutable
review content and expiry in D1; the decision and wake intent commit together.
Native events only wake execution, which must consume the canonical approval under
current authority. Review descriptors are shared by headless clients and web views.
Opt-in durable triggers transfer their leased dispatch into the run admission
transaction. The dispatch ID remains the logical event identity. Pinned trigger
configuration and current membership fence resumed work; pausing or changing the
trigger cancels active runs. Pending observations coalesce; manual/webhook intake
has a bounded backlog. The existing scheduler and signed ingress remain in control.
Worker deployment now freezes its candidate and fences new durable admissions
in D1 while comparing active handler pins inside the candidate runtime. An
uncertain upload retains that fence for explicit operator recovery. Hosted
activation/restart acceptance remains open; request-mode handlers keep their
original execution semantics.
See [durable execution](durable-execution.md) for the engine and authority gates.

[Delivery evidence](runtime-delivery-status.md) records implemented versus
verified behavior; [headless runtime](headless-runtime.md) documents the new API.

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
  Fly/LangGraph runtime. New agents default to `openai/gpt-6-luna` with
  `reasoning.effort=none`; saved per-agent model selections remain authoritative.

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

### External-action review authority

Migration 0031 adds immutable review bindings and CHECK-backed ledger transitions
to the existing D1 control plane. Approval and dispatch each atomically validate
current authority against the reviewed payload, policy, credentials and state.
Bounded scheduler expiry revokes pending work while preserving accepted effects.
Reviews participate in export and purge; exports omit internal vault references.
See [review design](action-review-design.md). Provider operation isolation and
response reconciliation remain separate delivery gates.

### Credential-isolated operation dispatch

Experimental named provider operations run inside the Cloudflare broker. Packages
supply an approved domain payload; the platform controls the operation registry,
destination, method, signing and credential access. Migration 0032 separates
provider receipts from action projection. A recorded dispatch is never reclaimed
for another mutation; read-only reconciliation and projection repair preserve its
identity. Provider resource lifecycle (pending/active/rejected) is distinct from
dispatch acceptance. Recovery without a receipt atomically proves absence and
fences proposal admission; it cannot race a dispatcher into a false no-effect
result. The public API exposes redacted receipts separately from action status,
with shared response schemas for frontend and headless clients. See
[provider operations](provider-operation-contract.md).
