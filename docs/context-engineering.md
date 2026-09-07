# Context Engineering

Operloom should not rely on vague chat memory for important decisions. The framework needs durable, inspectable context records that explain what the agent believed, why it believed it, and what would change its mind.

For the build-ready context assembly algorithm, see
`docs/context-assembly.md`. This page focuses on durable reasoning records and
recall behavior.

## Decision Records

A `DecisionRecord` is the generic unit for durable reasoning. It works across deployments, documents, research, ticket triage, market workflows, and other domains.

The durable entity contract lives in `docs/db-contracts.md`. This page explains how those records should be used for grounded recall.

Each record should capture:

- Tenant scope: `userId` and `workspaceId`.
- App-defined category data when useful: belief, strategy, plan, action, policy, preference, or another domain-specific category.
- Thesis: the claim or decision.
- Evidence, counter-evidence, alternatives, confidence, and freshness when the app needs them.
- Provenance: user note, tool result, workflow output, external trigger, manual override, artifact, or run.
- Related runs, tool calls, artifacts, managed-state records, and other links through provenance, artifact references, or extension data.
- Status: active, superseded, rejected, stale, or archived.
- Domain extension data for app-specific fields.

Summaries are indexes, not truth. The agent should answer "why?" by retrieving decision records and linked artifacts, then explaining from that grounded context.

## Recall Rules

- Important workflow outputs should create or update decision records.
- User-provided intuition should become a user-note provenance source before it influences a durable strategy.
- The agent should distinguish current, stale, and superseded beliefs.
- Domain-specific fields belong in extension data, not in the core schema.
- A decision can be confident only if it can point to provenance.

## Context Assembly

Context assembly should be explicit before operloom adds compression or
advanced memory behavior.

Suggested tiers:

- Stable: agent identity, app/domain rules, and guidance for the currently exposed
  tools.
- Scoped: trusted workspace, domain context, thread, and active run state.
- Retrieved: relevant decision records, managed state, ledgers, artifacts, and
  audit summaries.
- Volatile: current time, model/provider metadata, active interrupt state, and
  recent lifecycle events.

The model should not infer tenant scope from prompt text. Scope is derived by
the runtime and applied at the data-client boundary.

## Generic Examples

Trading:

`observe markets -> analyze conviction -> propose trade -> execute order -> review position`

Deployment:

`observe CI -> analyze failure -> propose fix -> execute deploy -> review logs`

Document workflow:

`observe source docs -> analyze gaps -> propose edits -> execute revision -> review diff`

Issue triage:

`observe issue queue -> analyze priority -> propose assignment -> execute label/update -> review outcome`

The same context model should support all of these flows.
