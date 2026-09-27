# Architecture

Operloom is a reusable agent workbench: a conversational control plane on
Cloudflare, a signed Node.js runner for heavy tools, and a Next.js web console.
Customer- or domain-specific behavior belongs in workspace, agent, policy, tool,
context and integration configuration or in a fork's Runtime Modules, not in
hard-coded product assumptions.

## System Shape

- The Cloudflare Worker serves only `/v1` to the network. It resolves
  authorization, workspace, active agent and thread, chat coordination, runtime
  events and all control-plane state.
- The Next.js App Router console is a `/v1` client. Its same-origin routes
  (`app/api/workbench/*`, `app/api/v1/me/*`) call the Worker with the signed-in
  WorkOS access token, or the local API token in development. No identity
  headers or facade signatures cross that boundary.
- WorkOS AuthKit runs at the web boundary; the Worker verifies WorkOS access
  tokens itself.
- assistant-ui renders the thread, composer, messages, reasoning, tools and
  attachments.
- Cloudflare Agents own chat through a per-thread `ThreadChatAgent` Durable
  Object. `SessionAgent` owns per-user/workspace session snapshots, thread and
  agent switching, and live session events.
- Durable Object SQLite holds hot per-thread messages; D1 holds canonical
  product and control-plane state.
- The signed runner (`runner/server.ts`) executes runner-transport tools and
  reports results through signed callbacks.
- OpenRouter is configured server-side. New agents default to
  `openai/gpt-6-luna`; saved per-agent model selections remain authoritative.

```txt
Browser -> Next.js console (WorkOS session)
        -> Cloudflare Worker /v1 (authz, chat/session, control state, D1)
        -> Cloudflare Agents (chat)
        -> signed runner (heavy tools only) -> signed callbacks -> Worker
```

Native clients are WIP on `codex/mobile-wip` and use the same
`@operloom/client` contract against `/v1`.

## Runtime Guarantees

- Typed state: scoped records, declared indexes, receipts, immutable
  decisions/effects and outbox events commit in one D1 batch with
  database-enforced preconditions. Simulation and external targets stay
  separate, and each agent's effect target is pinned on its runs.
- Execution revisions: agent revisions are pinned in identities and signed chat
  claims; D1 checks them at admission and typed-state ports check them on reads
  and commits. Idle-agent package upgrades use immutable snapshots.
- Chat admission: HTTP chat commands register in D1 before acknowledgement and
  link atomically to one run; deadline recovery closes abandoned work without
  re-executing it.
- Context: resolvers receive immutable scope and read-only state; evidence and
  run linkage commit atomically, and stale required evidence blocks work.
- Models and budgets: structured model calls use the configured model with
  schema validation. D1 admits model/tool reservations against workspace and
  root-run budgets (a default policy is seeded) and refuses them while a
  workspace or pack kill switch is active.
- Durable execution: submissions, step attempts and outcome receipts live in
  D1; native Workflows supply steps, timer waits and `202` submission. Unknown
  unsafe attempts never redispatch.
- Triggers: schedules and monitors dispatch through a leased D1 scheduler
  (local development ticks it every minute); webhooks verify per-trigger
  secrets. Durable triggers hand their dispatch to run admission.
- Approvals and actions: every action is proposed, reviewed and approved
  against immutable review content; approval and dispatch re-validate current
  authority, and kill switches cancel pending proposals.
- Provider operations: named operations run inside the Cloudflare broker with
  platform-controlled destination, signing and credentials; receipts are kept
  separate from action projection and reconcile without redispatch.

See [headless runtime](headless-runtime.md) for the public API.

## Control Plane Model

The core runtime model is:

```txt
trusted identity -> workspace/member/agent resolution
  -> policy and tool exposure
  -> chat, typed workflow intent, or tool run
  -> run/control records
  -> audit, artifacts, decisions, traces, and events
```

Chat stays on Cloudflare Agents. Workflows run in the Cloudflare workflow
kernel; a step uses the signed runner only when a tool needs container
execution, browser automation or other heavy work.

The generic workflow lifecycle remains:

```txt
observe -> analyze -> propose -> execute -> review
```

## Generic Subsystems

- Identity and tenancy: every durable read/write is scoped to a user,
  workspace, membership, and agent resolved from the verified caller.
- Tool registry and exposure: installed tools can be broader than the
  model-visible set; exposure is resolved by policy, agent, stage, execution
  mode, and approval state.
- Server-side execution: browser code can request, approve, and inspect tools,
  but secrets and tool credentials stay server-side.
- Run control: foreground/workflow runs and trigger dispatches track
  cancellation, retry/replay, leases, heartbeats, concurrency, and recovery as
  durable state.
- Canonical state: outputs return as typed state, decision and effect entries,
  artifacts, audit events, traces, UI events, immutable action proposals, and
  append-only action-ledger entries.
- Observability: Admin and D1 runtime summaries are product truth; Sentry and
  external tracing are downstream visibility layers.

## Important Seams

- `app/assistant.tsx`: assistant-ui runtime bridge to Cloudflare Agents.
- `lib/workbench/use-agent-connection.tsx`: loads the Cloudflare-owned session
  and active Agent connection.
- `components/assistant-ui/*`: reusable assistant-ui components.
- `components/workbench/*`: product-specific shell, sidebar, operations panel,
  runtime hints, and Admin surfaces.
- `app/api/workbench/*`, `app/api/v1/me/[...path]/route.ts` and
  `lib/workbench/control-plane-client/transport.ts`: console routes that call
  Worker `/v1` with the caller's bearer token.
- `app/api/external-signals/[publicId]/route.ts`: forwards per-trigger webhooks;
  the Worker verifies each trigger secret and takes tenant scope from the
  retained trigger, never the caller.
- `cloudflare/control-plane/src/public-api.ts`: the `/v1` boundary
  (authentication, route allowlist, error mapping).
- `cloudflare/control-plane/*`: Worker, D1 schema/migrations, Durable Object
  Agents, authz, policy, chat, tools, events, traces, and the
  schedule/monitor/webhook trigger runtime.
- `cloudflare/control-plane/src/runtime-workflows.ts`: the package workflow
  kernel for schema/resource checks, scoped execution, state and response
  formatting.
- `cloudflare/control-plane/src/runtime-tool-execution.ts`: the shared
  inline/runner dispatcher used by workflows, model tools, and Admin tools.
- `cloudflare/control-plane/src/runtime-run-lifecycle.ts`: atomic D1 start,
  promotion, terminal publication, trigger completion, and cancellation.
- `cloudflare/control-plane/src/action-authority.ts`: durable proposals,
  policy/approval rechecks, kill switches, execution CAS, terminal ledger, and
  ambiguous-outcome reconciliation.
- `cloudflare/control-plane/src/provider-operations.ts`: credential-isolated
  provider operations and their receipts.
- `cloudflare/control-plane/src/connection-broker.ts`: tenant-scoped WorkOS
  Vault metadata, OAuth/API-key authorization, refresh/revoke/health, and
  provider-host-scoped request capabilities.
- `cloudflare/control-plane/src/workspace-data-lifecycle.ts`: asynchronous
  D1/R2/DO export plus workspace quarantine, recovery, and purge.
- `cloudflare/control-plane/src/pack-test-runtime.ts`: in-memory control plane
  for package acceptance tests.
- `runner/server.ts`: the signed Node.js tool runner.
- `workbench.config.ts`: the only manual registry for trusted build-time
  Runtime Modules.
- `packages/agent-sdk/*`: the Runtime Module v2 public contract.
- `generated/agent-runtime/*`: deterministic manifest, Cloudflare, runner, web,
  conformance, and compiled-workbench-version registries.
- `examples/complex-operator/*`, `examples/resource-allocator/*`: external-style
  extension and complex-operator proofs.

## Deployment Boundary

Local development runs every service under one supervisor:

```bash
pnpm operloom dev
```

It starts the console on 3000, the Worker on 8787, the signed runner on 3101 and
a one-minute trigger scheduler, with local API authentication. Hosted targets
deploy the same three pieces separately: the Worker and D1 to Cloudflare, the
runner to Fly, and the console to the configured web host. See
[environments](environment-separation.md) and
[Fly runner deployment](deployment-fly.md).

The web host owns sign-in and browser ergonomics. Cloudflare is the
authorization, control-plane, chat coordination, and canonical-state boundary.
The runner only executes.
