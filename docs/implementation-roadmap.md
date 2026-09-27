# Runtime delivery roadmap

The approved direction is a production agent runtime with interchangeable
frontends. Cloudflare owns identity, authorization, canonical state, policy,
approval and audit. The signed Node runner owns heavy tools. LangGraph is an
explicit graph delegate. Cloudflare Workflows will own resumable steps. Trusted
packages remain build-time dependencies. The license is unchanged.

Released 1.0 scope remains web chat, trusted packs, read-only workflows,
artifacts and history. New work is experimental until its acceptance gate is
recorded. Repository tests do not establish hosted readiness.

## Milestones and acceptance

| Milestone                   | Delivery                                                                                                  | Acceptance gate                                                               | Status           |
| --------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------- |
| 1. Compatibility            | Baseline, v2 requirements/compiler, v1 adapter, external package fixture, snapshots                       | Existing v1 conformance unchanged; external v2 package installs               | Locally accepted |
| 2. Independent backend      | WorkOS JWT in Worker; explicit scope; versioned API; shared contracts; backend-only supervisor/deployment | Next stopped: authenticate, create thread, submit, inspect, approve, export   | In progress      |
| 3. Portable chat/events     | Fetch transport, public messages, idempotent HTTP turns, SSE/replay/reset/polling, optional React         | Plain browser JS and Node disconnect/reconnect journey                        | In progress      |
| 4. Typed state              | Schemas/indexes, reads, atomic commits/receipts/outbox, stable upgrade scope, reviewed migrations         | Conflicts roll back everything; no duplicated effects; lifecycle coverage     | In progress      |
| 5. Context/decisions/models | Scoped resolvers, versioned evidence, structured model calls, reservations, recorded no-op                | Stale evidence blocks; unchanged inputs consume no provider usage             | In progress      |
| 6. Durable execution        | Workflows adapter, 202 runs, steps/waits/approvals, version pinning, resume authority checks              | Crash/deploy/disconnect/duplicate webhook/approval delay preserve logical run | In progress      |
| 7. Controlled effects       | Simulation isolation, hashed expiring approvals, provider broker, reservations, reconcile/project         | Changed content cannot execute; reconciliation/repair do not redispatch       | In progress      |
| 8. Operator/adoption        | State/Decisions/Automations/Action views and APIs, notifications, two examples, scaffold/runbooks         | External consumer and both clients observe identical outcomes                 | Pending          |

## Cross-cutting gates

State inspection, decision/effect listing and failed-delivery retry now have
shared schemas, Fetch methods and local Worker acceptance. These complete the
headless state read/retry surface. Bounded declarative schema migration and index
rebuild now have local concurrency/replay coverage and a Worker resume drill.
Reviewed partial-migration repair now preserves completed state and serializes
against advancement. Execution revisions now fence stale run admission and state
handles in D1. Pending HTTP chat commands now join the same revision fence before
acknowledgement; terminal outcomes, cancellation and expiry are inspectable through
the shared API. Explicit idle-agent package upgrades now preserve immutable snapshot history,
validate state and trigger compatibility, and commit replay receipts and audit
atomically. Large-installation resumable validation, complete deletion acceptance
and bundled operator views remain outstanding.

Scoped resolvers and immutable evidence now share the chat/workflow boundary.
The document-review example records deterministic observations and no-op decisions
without provider usage. Required-context blocks and atomic typed-state expiry
checks are implemented. Structured workflow model calls and concurrent workspace/
root-run budget reservations now cover workflows, chat steps and tool dispatches;
known usage, estimates and deterministic fixtures are reported separately.
Model/budget distribution acceptance passes locally; hosted acceptance remains
pending. Evidence and current verification are tracked in the delivery ledger.

Durable submission and step persistence now have transaction/replay tests and
lifecycle storage. State/context commits and model/tool admission now enforce
active attempts atomically, with locally tested expiry races and replay. The
native engine, `202` acceptance, fresh step contexts and timer waits now have local
acceptance. Automatic process-restart recovery fails in the installed emulator;
explicit-wake replay passes. Leased engine reconciliation now covers startup gaps,
deadlines, revoked authority, failed/completed engine projection gaps and physical
cancellation. Backoff rotates failed inspections through bounded batches.
Per-step context capture now refreshes evidence after waits, preserves each
original capture across retries and exposes ordered history to independent clients.
The document-review example verifies content before applying the saved state read.
Approval checkpoints now persist immutable content, expiry, decisions and wake
intents; ordinary native approval/denial has local acceptance. Restart acceptance
remains separate. Durable trigger admission now links one dispatch to one run,
rechecks pinned trigger authority, coalesces pending observations and bounds ingress.
Native scheduled/webhook execution and pause revocation pass local conformance.
The deployment command now checks active handler compatibility under a D1
admission fence and retains uncertain activation for operator recovery. Hosted
deployment/restart/backlog recovery and external-action authority remain open.
Bounded native deletion
now precedes D1 purge, with dispatch uncertainty retained; operator reconciliation
of unknown/historical dispatches and hosted deletion acceptance remain open.
The durable capability is not advertised to packages.

- Compatibility: retained snapshots, v1/v2 coexistence, upgrades and state continuity.
- Isolation: signature/issuer/expiry/client claims; membership revocation; forged headers and cross-tenant lookup.
- Consistency: multi-record conflicts, changed idempotency payloads, reservations, crash recovery/replay.
- Authority: expiry, changed inputs, revoked connections, kill switches, simulation and broker isolation.
- Transport: acceptance independent of SSE; cursor expiry; token refresh; simultaneous clients; frontend absent.
- Operations: forward migration/restore, export/delete, backlog, workflow/notification failure, reconciliation.

Run focused checks during changes, then SDK/client conformance, typecheck, lint,
build and affected service/browser suites. Browser and Docker verification run
sequentially under supervision.

## Production rollout

The explicit simulation action slice is implemented behind its own disabled flag;
its acceptance and limitations are recorded in [simulation contracts](runtime-simulation.md)
and the delivery ledger. This does not complete controlled external operations or
approval-bound simulation.

Release gated stages: public API → stateful simulation → durable background
operation → approved external operation. Collect same-commit hosted evidence,
real authentication, a minimum 24-hour automation soak, controlled external-action
drills and a restore rehearsal before any production claim. Publish measured
latency, throughput, backlog recovery and provider costs with tested limits.
See [runtime delivery status](runtime-delivery-status.md).

Polymancer, financial providers, custody, native UI, remote executable installation,
marketplace, arbitrary multi-agent delegation and cloud-provider independence
remain outside delivery.

### Controlled-effects review increment

Bound external-action reviews, expiry and atomic approval/dispatch admission are
implemented for local acceptance under migration 0031. This does not complete
provider-owned operations, external resource reservations, reconciliation or
projection repair. See [review design](action-review-design.md) and the delivery ledger.

### Provider-operation increment

The declarative v2 binding, credential-isolated bearer/HMAC broker, immutable
dispatch receipts, read-only reconciliation and action/run projection repair are
implemented behind an opt-in flag. Native Worker/HTTP acceptance now covers a
registered external package, both authentication methods, response loss,
projection repair and populated lifecycle deletion. Atomic no-dispatch recovery
and headless receipt inspection are implemented. A disposable hosted provider
drill, domain resource reservations/state projection, pending resource observation
and the full resource-allocation example remain open. Web History now exposes
receipt evidence and projection repair; the broader State, Decisions and
Automations operator views remain part of milestone 8.
