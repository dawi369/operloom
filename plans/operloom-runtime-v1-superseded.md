# Operloom: a production agent runtime with interchangeable frontends

## Outcome and architectural decisions

Make Operloom a backend developers can use to build stateful, continuously operating agent products. A product should be implementable through a trusted package that supplies domain schemas, context, tools, workflows, policies, and presentation descriptors.

The supported loop becomes:

**Event or user request → scoped context → decision → proposed action → authorized execution → durable state and evidence → operator notification.**

The bundled web workbench becomes one client of that runtime. A developer must be able to deploy and operate the backend with Next.js absent.

Decisions:

- Keep Cloudflare responsible for identity resolution, authorization, canonical application state, policy, approvals, and audit. Keep the signed Node runner for heavy tools and LangGraph for explicit graph delegation.
- Add Cloudflare Workflows for resumable execution. Today’s workflow kernel executes a handler under a request deadline; durable run records alone do not make that handler resumable.
- Extend platform-owned storage through typed, scoped operations. Packages receive neither raw D1 access nor arbitrary SQL or migration privileges.
- Introduce an opt-in **Runtime Module v2**, with the existing v1 contract supported through an adapter. Preserve existing agents, snapshots, routes, and package identities.
- Build and prove general capabilities using non-financial examples. Polymancer integration, trading adapters, wallet custody choices, and Expo implementation remain later product work.
- Frontend independence covers APIs, chat, streaming, administration, authentication integration, and deployment. Cloud-provider independence is outside this plan.

This is a sequence of releasable milestones. Each milestone must pass its acceptance gate before capabilities are advertised as production ready.

## Implementation milestones

### 1. Establish the baseline and compatibility rules

- Finish verification of the existing freshness, progressive-history, and pack-outcome changes. Inspect the current dirty tree and preserve work already in progress.
- Reconcile documents that describe conflicting release states. Record which capabilities are implemented, locally verified, hosted-verified, or experimental.
- Add Runtime Module v2 schema and compiler dispatch while retaining v1 support. Update SDK contract snapshots, package-consumer verification, and changelogs.
- Add explicit capability negotiation: a package declares required runtime capabilities and minimum backend version; incompatible execution fails with an actionable error.
- Keep existing signing headers and resource identities stable. Use forward database migrations and preserve historical agent snapshots.

**Acceptance:** existing v1 packages and clients pass their current conformance tests unchanged; a minimal v2 package installs through the external-package test path.

### 2. Make the backend independently usable

Create a versioned public API on the Cloudflare backend and make it the canonical interface for every frontend.

- Extract Next.js-dependent identity derivation into a backend authentication module. Supply a production WorkOS token verifier and an explicitly local development adapter.
- Verify token signature, issuer, expiration, and authorized client claims server-side. Resolve workspace membership and permissions from Operloom’s canonical records.
- Keep the existing Next.js cookie facade as a compatibility adapter. It must call the same authorization and command modules as direct API clients.
- Expose all operational capabilities through the API: agents, threads, runs, state, decisions, triggers, approvals, connections, notifications, retention, export, deletion, and kill switches. Preserve their existing role requirements.
- Use explicit workspace and agent targets for commands. A client’s selected workspace must not redirect another client’s in-flight request.
- Generate OpenAPI and runtime validators from shared contracts. Standardize errors, request IDs, idempotency keys, pagination, cancellation, and asynchronous acceptance responses.
- Add a supervised backend-only development profile and separate backend deployment configuration. Startup must not require Next.js, React, or web-only environment variables.

WorkOS supports server-side JWT verification through its published signing keys; authentication does not require a Next.js host. [WorkOS sessions](https://workos.com/docs/authkit/sessions)

**Acceptance:** with Next.js stopped, a command-line consumer can authenticate, create a thread, submit work, inspect results, approve an action, and export its workspace.

### 3. Finish frontend-independent chat and events

The existing headless client is a useful starting point, but consumers still need application-specific transport wiring.

- Ship a concrete Fetch-based transport in `@operloom/workbench-client`, covering authenticated commands, streaming, reconnection, cancellation, and token renewal.
- Define public message and content-block contracts independent of assistant-ui and Cloudflare wire messages. Translate existing stored messages through adapters.
- Accept chat turns through idempotent HTTP commands. Return canonical acceptance without waiting for a realtime connection.
- Provide authenticated SSE for observing transcript changes, run progress, approvals, state updates, and notifications. Support polling when streaming is unavailable.
- Retain cursor-based replay for durable events; return an explicit reset instruction when a cursor expires. Clients then fetch canonical state. Transient text deltas need not be retained individually.
- Extend the shared client with administrative resources currently confined to the web app.
- Keep React hooks and renderers in optional packages. Generic schemas and artifact descriptors must let another frontend operate every package without React.

**Acceptance:** a plain JavaScript browser client and a Node consumer complete the same chat/run journey, including disconnect and reconnect. Neither imports Next.js, React, assistant-ui, or Cloudflare transport internals.

### 4. Add typed state and atomic domain operations

The principal runtime gap is in the [execution context](/Users/dawi/dev/operloom/packages/agent-sdk/src/runtime.ts): packs can write managed state but lack a complete read, query, and atomic-update interface.

Add a v2 state module with:

- `get` and paginated `list`, restricted to declared namespaces and record kinds.
- Schema-validated records with explicit schema versions and bounded declared indexes.
- `commit`, accepting a bounded read-version set, record writes, immutable decision/effect entries, and an idempotency key.
- Atomic success or failure across the complete commit, including durable event-delivery intents.
- Stored commit receipts: repeating the same key and payload returns the original result; reusing a key with different content fails.
- Explicit optimistic concurrency conflicts. The runtime must not silently replace the expected version with the latest version.
- A server-owned stable state scope that survives an explicit agent/package upgrade. Creating an unrelated agent still creates isolated state.
- Package-defined record schemas stored through generic platform tables. Platform code owns indexing, migration execution, quotas, lifecycle fencing, export, and deletion.
- Explicit schema migration commands using reviewed, bounded transformations. Older schemas remain readable until migration finishes; incompatible writers fail closed.

Implement commits using D1 transactional batches with database-enforced preconditions. Checking affected-row counts after partially committing writes is insufficient. [D1 transaction semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/)

**Acceptance:** concurrent updates cannot lose changes; a failed precondition leaves every record unchanged; replay cannot duplicate an effect; export, upgrade, quarantine, recovery, and deletion include the new records.

### 5. Make context, decisions, and model work reusable

Turn the existing context descriptors and decision storage into usable runtime capabilities.

- Bind declared context sources to executable, scoped resolvers. Sources return schema-checked data with provenance, observation time, expiry, and trust classification.
- Build bounded context snapshots for both conversations and background workflows. Record the snapshot and configuration versions used for each decision.
- Treat missing required context as a blocked run. Optional missing or stale context must remain visible in the result.
- Add a platform-owned structured model-call interface for workflows, using the configured model, validated output schemas, cancellation, and resource limits.
- Persist decisions with their evidence references, public explanation, outcome, and links to proposals and state changes. Store explanations and evidence, rather than hidden chain-of-thought.
- Add per-run and per-workspace model/tool limits with concurrency-safe reservations. Report known usage and estimates separately; stop additional calls when limits are exhausted.
- Allow a deterministic observation step to finish without a model call when no meaningful change occurred.

**Acceptance:** manual and background execution use the same context and policy rules; required stale evidence blocks execution; unchanged input can produce a recorded no-op without provider usage.

### 6. Make execution survive interruptions

Add a durable execution adapter backed by Cloudflare Workflows, while keeping Operloom’s run records authoritative for operators.

- New v2 submissions return `202` with a durable run identity. The runtime starts work independently of the initiating HTTP connection.
- Link each workflow-engine instance to one Operloom run. Use stable submission identities to recover a crash between recording the run and starting the engine.
- Expose named, versioned steps, waits, and approval pauses through a small runtime interface. Save completed step outputs and resume from them.
- Pin package, workflow, context, and policy-relevant versions. Retain compatible handlers for active executions; block an upgrade that would strand them.
- Reuse existing triggers, leases, webhook validation, and recovery mechanisms. Add explicit deduplication, bounded backlog handling, and coalescing for repeat observations.
- Carry a stable event identity through dispatch, decision, proposal, and commit. A retried attempt gets a new attempt identity without changing the logical operation.
- Retry only operations declared safe, within bounded limits. External actions with ambiguous outcomes require reconciliation.
- Cancellation and pause revoke future execution authority. Previously committed state and accepted external effects remain visible.
- Recheck membership, current execution policy, and kill switches when work resumes.
- Keep minute-scale monitors as the baseline. Persistent external event collectors may feed authenticated ingestion; they do not become a second control plane.

Cloudflare Workflows supplies durable steps, recovery, and waits; its replay constraints must be reflected in package authoring and tests. [Workflow execution rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)

**Acceptance:** termination between steps, browser closure, duplicate webhook delivery, approval delay, and deployment restart preserve one logical run and its recorded effects.

### 7. Complete controlled effects and provider operations

Keep execution intent separate from the effect destination.

- Preserve `ask`, `dry_run`, and `execute`. Add a v2 action target distinguishing a persisted simulation from an external action; existing v1 action bindings retain their external semantics.
- Store simulation state under a separate server-selected scope. A simulation may read authorized evidence but cannot dispatch external mutations.
- Commit simulated effects, state changes, decision links, and receipts atomically.
- Extend existing proposal/approval handling with expiry, payload hashes, relevant state versions, and pre-execution checks. Material changes require a new proposal and approval.
- Implement the credential-isolated operation interface already described in [provider-operation-contract.md](/Users/dawi/dev/operloom/docs/provider-operation-contract.md). Provider modules own signing, authentication, permitted destinations, schemas, redaction, and reconciliation.
- Keep signing material inside the broker. Packages reference named operations and receive validated, redacted results.
- Model dispatch outcome separately from an external resource’s lifecycle: successful submission can create a pending external resource requiring later observation.
- Record external outcomes durably before projecting them into application state. Projection failures must be repairable without submitting the external operation again.
- Add general state precondition and resource-reservation hooks; domain packages supply their specific constraints.
- Prove both ordinary authenticated HTTP and signed-request operations using non-financial providers. Use an isolated disposable resource for hosted acceptance.

**Acceptance:** approval cannot authorize changed content; concurrent operations respect reservations; lost responses become `outcome_unknown`; reconciliation and projection repair never duplicate the external action.

### 8. Provide complete operator controls and developer adoption

Deliver the general web controls alongside their headless equivalents.

- Extend the existing workbench with focused State, Decisions, Automations, and Action detail views.
- Show currentness, evidence, active work, next scheduled run, simulation/external target, policy blocks, and recovery options.
- Preserve cached results during refresh and load large artifacts on demand.
- Expose trigger enable/pause, approval/denial, cancellation, safe retry, reconciliation, budget configuration, and kill switches through the same public API.
- Give notifications durable delivery identities, bounded retry, deduplication, delivery status, and an operator-visible failed-delivery state.
- Expand Complex Operator into a non-financial resource-allocation example: observe capacity → decide → propose allocation → simulate/approve → update allocations and remaining capacity.
- Add a second, smaller document-review example using the same interfaces. This verifies that generality does not depend on one example.
- Extend scaffolding to produce schemas, commands/queries, workflows, context resolvers, effect bindings, tests, and portable presentation descriptors.
- Supply a complete headless quickstart, package upgrade example, and backend deployment runbook. A package must require one registry entry and no edits to core routes.

**Acceptance:** a fresh external-package consumer implements and runs both examples; the bundled web app and an independent client observe identical canonical outcomes.

## Verification and production rollout

Apply these checks throughout implementation, not only at the end:

- **Compatibility:** old package/client fixtures, retained snapshots, v1-to-v2 coexistence, explicit upgrades, and state continuity.
- **Isolation:** user/workspace/agent/package scope, forged headers, invalid tokens, expired sessions, membership revocation, and cross-tenant resource lookup.
- **Consistency:** atomic multi-record conflicts, duplicate requests with changed payloads, concurrent reservations, crash recovery, and replay.
- **Authority:** approval expiry, changed inputs, revoked connections, every kill switch, simulation isolation, and credential redaction.
- **Transport:** HTTP acceptance without SSE, interrupted streams, cursor expiry, token refresh, multiple simultaneous clients, and backend-only operation.
- **Outcomes:** meaningful pack-owned assertions; deterministic fixtures remain the default. Small opt-in provider/model checks verify real integration separately.
- **Operations:** forward migration, backup/restore, export/deletion, queue/trigger backlog, workflow failure, notification outage, and provider reconciliation.

Run focused tests per change, then SDK/client conformance, typecheck, lint, build, and affected service/browser suites. Use the supervised commands; browser acceptance and Docker verification run sequentially.

Release in stages: frontend-independent API → stateful simulation → durable background operation → approved external operation. Keep new capabilities disabled until their corresponding gates pass.

Before the final production claim, collect same-commit hosted evidence, a minimum 24-hour automation soak, real authentication acceptance, controlled external-action drills, and a restore rehearsal. Publish measured latency, throughput, backlog recovery, and provider-cost results with their tested limits.

## Completion criteria and defaults

The plan is complete when:

1. Operloom runs without its bundled frontend.
2. Developers can build a stateful application using the documented package and client interfaces.
3. Background work survives interruption and produces auditable decisions and effects.
4. Simulation and approved external execution are independently enforceable and verifiable.
5. Operators can inspect, pause, recover, export, and delete their application state.
6. Two independent examples demonstrate the same general contracts.
7. Production readiness is supported by hosted evidence rather than repository tests alone.

Defaults: WorkOS remains the production identity provider; Cloudflare remains the backend platform; trusted build-time packages remain the extension model. The existing license remains unchanged. Remote executable installation, a marketplace, financial adapters, native UI implementation, and arbitrary multi-agent delegation are outside this delivery.

Update the existing product, architecture, roadmap, runtime-contract, and acceptance documents as milestones land. Preserve the distinction between a generally capable runtime and a product’s own domain correctness.
