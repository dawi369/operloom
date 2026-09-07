# Capability Model

Operloom measures operational sophistication separately from external
authority. A pack cannot acquire either by prompt wording or manifest metadata:
the compiled runtime, workspace policy, platform gates, and executable evidence
must all agree.

Document status: current 0.5 implementation and future 1.0 contract. The local
implementation targets Operational L3 and Authority A2; the public 1.0 claim
still requires the hosted evidence below. Delegation is deferred and is not a
prerequisite for direct mutation safety.

## Operational axis

| Level | Capability              | Required platform guarantees                                                                             |
| ----- | ----------------------- | -------------------------------------------------------------------------------------------------------- |
| L0    | Conversational          | Scoped identity, immutable behavior snapshot, thread continuity, bounded context                         |
| L1    | Tool-using              | Typed tools, model-exposure policy, structured results, timeouts, redaction, audit                       |
| L2    | Workflow-driven         | Typed intents, durable runs, artifacts, approvals, cancellation, retry, recovery                         |
| L3    | Background/event-driven | Trusted triggers, schedules, idempotency, leases, heartbeats, concurrency, replay, alerts                |
| L4    | Delegated               | Parent/child lineage, narrowed authority, depth and budget limits, durable handoff, cascade cancellation |

L0–L2 are release-gated by `conformance:level2`; L3 is implemented and gated by
`conformance:level3` plus hosted soak, redelivery, and signed-in operator
evidence for the release commit. L4 remains deferred.

## Authority axis

| Level | Capability         | Required platform guarantees                                                                                                            |
| ----- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| A0    | Read-only          | No provider credential custody or externally mutating dispatch                                                                          |
| A1    | Durable proposal   | Redacted immutable proposal, schema validation, policy decision, approval and cancellation history                                      |
| A2    | External execution | Vault-backed connections, explicit enablement, idempotent dispatch, kill switches, append-only ledger, ambiguous-outcome reconciliation |

A2 does not claim exactly-once external effects. It provides stable idempotency,
never automatically retries an ambiguous dispatched action, records
`outcome_unknown`, and requires reconciliation before an operator retry.

## 1.0 production boundary

The 1.0 implementation targets L3+A2 with these hard conditions:

- Retained data, connections, and mutations are separate ordered deployment
  feature gates. Production may enable the global mutation subsystem, but
  workspace mutation remains disabled by default and separately authorized.
- A workspace must confirm its retention policy and explicitly authorize a
  healthy connection before any mutation proposal can execute.
- Runtime Module v1 execute bindings declare external mutation risk, proposal
  and result schemas, connection identity, idempotency, timeout, reconciliation,
  and approval policy. The compiler rejects incomplete bindings.
- Cloudflare owns tenant scope, policy decisions, durable approval, proposal
  CAS, terminal publication, audit, and ledger state. Agent Packs only declare
  requirements and trusted adapters.
- WorkOS Vault stores credentials. D1 stores tenant-scoped metadata and opaque
  Vault object/version references only. Broker capabilities never return raw
  credentials to models, packs, Fly envelopes, callbacks, logs, or exports.
- Workspace, pack, tool, and connection kill switches fence new dispatch. They
  do not claim to reverse an external side effect already accepted.
- Workspace deletion immediately quarantines access, pauses triggers, cancels
  active work, and irreversibly revokes credentials. Content recovery lasts 30
  days; credentials, webhook secrets, approvals, and trigger enablement are not
  restored.

## Agent Pack composition

Pack API v2 manifests remain serializable. Trusted build-time Runtime Module v1
packages may provide schema-checked tools, workflows, actions, health/eval
bindings, and trusted renderers. They may declare:

- behavior, tools, workflows, triggers, context, managed state, and UI schemas;
- required connection providers, principals, scopes, and credential classes;
- execution modes, mutation risk, limits, approvals, and compatibility ranges;
- artifacts, health checks, deterministic evals, and reconciliation bindings.

The platform retains tenancy, credential custody, outbound-host enforcement,
retention, deletion, policy, approval, kill switches, lifecycle, and audit.
Installing a package never enables mutation.

## Runtime invariants

- The model never chooses tenant scope, credentials, approval bypass, budgets,
  feature gates, or kill-switch state.
- Terminal runs and terminal action proposals never reopen.
- Cancellation revokes publication authority but cannot undo an accepted
  provider side effect.
- Raw external request/response bodies are not durable evidence; redacted
  summaries, hashes, and provider references are.
- Every capability can explain what ran, why it was allowed, what changed, and
  how an operator can stop, recover, export, or delete it.

## Evidence

- Runtime packages: `pnpm conformance:agent-system`
- L0–L2: `pnpm conformance:level2`
- L3: `pnpm conformance:level3`
- Retained data: `pnpm conformance:data-lifecycle`
- Connection brokerage: `pnpm conformance:connections`
- Mutation authority: `pnpm conformance:actions`
- Same-commit hosted evidence: `pnpm acceptance:hosted:vault` and
  `pnpm acceptance:hosted:mutation`

The row-by-row release evidence matrix is in `production-1-conformance.md`.

Remote package installation, arbitrary executable uploads, credential
marketplaces, trading adapters, Polymancer mutation, Swordfish execution,
delegation, and multi-region failover remain outside 1.0.
