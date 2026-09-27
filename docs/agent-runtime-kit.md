# Agent Runtime Kit

## Runtime Module v2 (experimental)

`defineControlPlaneModuleV2` is exported from the SDK root and `/control-plane`.
A v2 module declares `requirements.minimumBackendVersion` and required capability
names. The compiler and runtime reject missing capabilities. v1 modules retain
their source and snapshot contracts and pass through a nonmutating adapter.
The external SDK consumer check installs both v1 and v2 package tarballs.

Supported implementation capabilities are `runtime.module.v2`,
`runtime.workflow.request.v1`, and experimental `state.atomic.v2` / `state.migrations.v2`. Typed state
also requires `WORKBENCH_TYPED_STATE_ENABLED=true` on the Worker. Declare
`state` record schemas and indexes on the module; use `requireRuntimeState(context)`
for scoped `get`, `list` and `commit`. Simulation is the only workflow state
target currently bound. Reads must supply explicit versions for every write.
State schema version changes require migration; normal commits reject them.
Declare reviewed `stateMigrations` alongside both source and destination `state`
schemas and require `state.migrations.v2`. The backend's admin migration commands pin and execute bounded field
transformations; the package receives no database or migration execution privilege.
An admin can select a different registered declaration to repair unfinished work,
provided both schemas and indexes are unchanged. Completed records remain intact.
See [state design](runtime-state-design.md) for bounds and remaining gates.
Frontends inspect canonical state and immutable entries through `runtime.state`
in the shared client. They do not receive the package's commit port. Delivery
retry requires a current admin role and an optimistic attempt-count precondition.

The experimental `context.snapshots.v2` capability binds manifest context sources
to schema-checked resolvers under `WORKBENCH_CONTEXT_ENABLED=true`. Both chat and
workflow invocations capture immutable scoped evidence. Required missing or stale
sources block work; typed commits check expiry in the same D1 transaction.
Use `context.context.snapshot` and `context.context.assertReady()` inside a package,
and `runtime.context.snapshot(id)` from the Fetch client. See [context authoring](runtime-context.md).

Experimental `models.structured.v2` and `usage.reservations.v2` supply
`context.models.structured({ idempotencyKey, prompt, outputSchema, maxOutputTokens })`
to workflows. The backend selects the configured model, validates output and
records public results/usage. Enable `WORKBENCH_STRUCTURED_MODELS_ENABLED` and
`WORKBENCH_USAGE_LIMITS_ENABLED`; an administrator must first configure workspace
limits. When usage enforcement is enabled, chat steps and tool dispatches also
reserve capacity before execution. Read [model/budget semantics](runtime-models-and-budgets.md)
for replay, unknown outcomes, token estimates and limits.

V2 bindings may additionally declare experimental durable orchestration using
`durable.execute`, `flow.step`, `flow.sleep` and `flow.approval`. Submission is opt-in and deployment
flags default off. Existing `execute` handlers keep their request-mode behavior.
Declared triggers can opt into `execution: "durable"` when instantiated through
the shared API. Their dispatch ID supplies the logical event identity; the runtime
owns lease transfer, coalescing, backlog limits and resumed trigger authority.
The [engine integration gates](durable-execution.md) still require hosted restart
acceptance, hosted deployment retention and complete engine lifecycle acceptance before the
negotiated `runtime.workflow.durable.v2` capability is advertised. Provider-operation
signing is also still unavailable.

Approval checkpoints bind immutable review content, version and expiry. The
backend records decisions and retries native wake delivery; continuation rechecks
membership, policy, expiry and kill switches. A review receipt does not grant
tool or external-action authority. The document-review example links the receipt
to its decision and revalidates evidence/state after the pause.

Durable startup and engine reconciliation are platform-owned. Recovery never
recreates a started instance or invokes a package handler to infer an outcome.
A stopped engine with no canonical result becomes blocked; unfinished attempts
remain `outcome_unknown`. Packages must preserve idempotency and reconciliation
semantics for effects already accepted before cancellation. Each new durable step
receives a new context capture; a retried step receives its original capture and
blocks if required evidence expired. `snapshot.captureKey`, `revision` and `stepId`
are optional on retained historical snapshots. Packages should link the current
snapshot and any earlier observation to their decisions, and validate meaningful
evidence changes before committing an effect derived from an earlier step.

Document status: current Runtime Module v1 authoring and enforcement contract.

The Runtime Kit turns a trusted build-time package into an executable Agent
Pack without editing application, Worker, or runner registries. The package is
listed once in `workbench.config.ts`; `pnpm agent-packs:compile` validates its
exports and deterministically generates environment-specific registries under
`generated/agent-runtime/`.

Remote installation and unreviewed executable uploads are not supported.
Packages execute with the authority of reviewed application code, while
tenant scope, policy, approvals, lifecycle writes, audit, and publication
authority remain platform-owned.

## Package Contract

Every package exports:

| Export            | Loaded by                   | May contain executable code     |
| ----------------- | --------------------------- | ------------------------------- |
| `./manifest`      | compiler and snapshot layer | no; Pack API v2 is JSON-safe    |
| `./control-plane` | Cloudflare Worker           | Cloudflare-safe tools/workflows |
| `./runner`        | signed Fly runner           | Node/container tools            |
| `./web`           | Next.js                     | trusted React renderers         |

Each runtime entry declares `packId`, one `runtimeVersion`, and
`compatiblePackVersions`. The compiler rejects inconsistent runtime versions,
missing tool/workflow/health/eval/renderer providers, collisions, invalid
schemas, engine mismatches, and incompatible current manifests. The root
`workbench.config.ts` also declares the exact workbench version. Every manifest's
minimum and optional maximum workbench version is checked both while compiling
and again during runtime resolution.

The publish-ready SDK is in `packages/agent-sdk`:

```ts
import { defineAgentPack } from "@operloom/agent-sdk/manifest";
import { defineControlPlaneModule } from "@operloom/agent-sdk/control-plane";
import { defineRunnerModule } from "@operloom/agent-sdk/runner";
import { defineWebModule } from "@operloom/agent-sdk/web";
```

Its JSON contracts are `schemas/agent-pack-v2.schema.json` and
`schemas/runtime-module-v1.schema.json`. `pnpm agent-sdk:verify` builds and packs
the SDK, installs the tarball into an ignored zero-context consumer, executes
every runtime export under Node 24, resolves declarations without TypeScript
path aliases, and compiles a separately packed Agent Module using only its
package name. The SDK is not published by this repository.

`pnpm agent-sdk:contract --check` compares normalized public declaration and
JSON Schema hashes with `packages/agent-sdk/contract-manifest.json`. An
intentional public change requires review, a changelog entry, and
`pnpm agent-sdk:contract --accept`. Additive Runtime Module v1 changes are
permitted; a source- or serialized-contract break requires a new API major.

## Execution Boundary

Workflow requests use the generic routes:

```txt
POST /api/workbench/workflows/<workflow-type>
  -> signed Vercel facade
  -> POST /workbench/workflows/<workflow-type>
  -> compiled Cloudflare runtime binding
```

Before package code runs, Cloudflare resolves the active immutable Agent Pack
snapshot, checks its runtime compatibility, validates input, evaluates every
tool policy, applies concurrency and resource limits, and creates the run
lifecycle atomically. Package handlers receive only `AgentExecutionContext`:

- frozen user/workspace/agent and run scope
- abort signal and declared resource ceiling
- policy-checked tool invocation
- compare-and-set managed-state writes
- scoped event append
- `ConnectionPort`
- `ActionPort`

Handlers never receive D1, Worker `Env`, auth headers, signing secrets, provider
credentials, or unrestricted network clients. Tool and workflow outputs are
schema-checked. Artifact size and tool-call count are enforced before
failure-atomic publication. Cancellation permanently revokes publication
authority; executor termination remains best effort.

Every supported pack uses the same compiled runtime registry and generic
Cloudflare execution kernel. Fly executors are loaded only by the signed runner;
Cloudflare never imports Node runner code.

## Connections And Actions

`ConnectionPort.resolve()` returns status and, for an authorized binding, a
provider-host-, method-, run-, tool-call-, and tool-scoped request capability.
For Fly actions the capability is short-lived and single-use; the runner calls
the Cloudflare broker, which injects the WorkOS Vault credential without
returning it to package code or the Fly envelope.

`ActionPort.propose()` persists an immutable redacted proposal and stable
idempotency key. `ActionPort.execute()` accepts only the stored proposal after
retention, connection, feature-gate, kill-switch, policy, and approval checks.
Ambiguous dispatched outcomes become `outcome_unknown` and require the
binding's reconciliation operation.

## Forms, Artifacts, State, Health, And Evals

- Workflow forms are arbitrary declarative fields backed by the binding input
  JSON Schema.
- History always has JSON, Markdown, and table fallbacks.
- The web registry can supply a trusted React renderer. Props are depth,
  count, and size bounded and keys resembling credentials are removed. A
  renderer error falls back to the generic renderer.
- Managed-state descriptors continue to project through generic tenant-scoped
  list/detail surfaces and CAS writes.
- Required runtime health bindings run as part of deep Worker health.
- Required deterministic evals run through `pnpm agent-packs:test` and the
  aggregate conformance gate.

## Complex Operator Golden Path

`examples/complex-operator` is an external-style, conformance-only package. It
proves a Cloudflare-native tool, signed Fly tool, multi-step workflow,
schedule/webhook declarations, managed-state CAS, structured artifact and
trusted renderer, required health/evals, connection authorization posture, and
a durable action proposal, OAuth/API-key connection posture, approval, and an
idempotent deterministic synthetic mutation. It performs no financial action
or public provider traffic.

`pnpm conformance:agent-system` executes that package through the isolated
Worker, signed local Fly-shaped runner, and D1 boundary, then verifies the
persisted runtime metadata, three tool calls, structured artifact, and managed
state. Static package tests remain separate so a registry declaration alone
cannot satisfy the extension gate.

`pnpm conformance:extension-contract` first packs the SDK and Complex Operator,
installs both into an ignored zero-context consumer, compiles package-only
registries, typechecks declarations, inspects archive hygiene, and executes
every workflow, tool contract, renderer, connection posture, health check, and
eval. This installed-package proof complements the deployed-shape
Cloudflare/Fly service-boundary journey.

To add a comparable package:

```bash
pnpm agent-packs:create --id my-operator --name "My Operator"
# edit only agent-packs/my-operator/* and its generated workbench.config.ts entry
pnpm workbench pack check --pack my-operator
pnpm conformance:agent-system
```

Generated registries are tracked. CI runs `agent-packs:compile --check`, so
configuration or package changes cannot land with stale environment registries.
The package-only compiler path resolves exports relative to the consumer
workbench, not this monorepo. `tests/fixtures/external-agent-package` locks that
boundary without granting remote-install authority.

For the complete founder workflow—including managed state, triggers, proposals,
renderers, verification, and Polymancer-specific stop conditions—follow
`docs/complex-agent-golden-path.md`.

For mutation-capable packages, the golden path is:

1. Declare `risk.externalMutation`, provider connection, principal, scopes,
   credential class, and affected tool IDs in the manifest.
2. Implement schema-checked dry-run proposal and action bindings. Execute must
   declare stable idempotency, timeout, approval posture, and an inline or Fly executor.
3. Use `ConnectionPort`; never accept, log, persist, render, or return a raw
   credential. Provider hosts and methods come from the platform provider module.
4. Supply reconciliation for executors that can time out after dispatch. Never
   automatically retry an `outcome_unknown` proposal.
5. Add required health/eval bindings and generic redacted History rendering.
6. Pass package, compiler, agent-system, connection, and action conformance.

Installation grants no authority. A workspace owner must confirm retention,
authorize the connection, explicitly enable mutation for the tool, and clear
applicable kill switches; approval is mandatory unless an editable workspace
policy explicitly permits autonomous execution.

Provider-specific wallet or payload signing is not represented by ordinary
bearer/API-key injection. Its target credential-isolated extension boundary is
documented in `docs/provider-operation-contract.md`; no signing executor is
claimed by Runtime Module v1 today.

## Compatibility And Limits

An incompatible historical Agent snapshot remains available for chat. Pack and
runtime range drift returns `runtime_incompatible`; workbench range drift
returns `workbench_incompatible`. Both block tools, workflows, triggers,
retries, and actions until an explicit agent upgrade creates a compatible
snapshot. The experimental [explicit upgrade command](package-upgrades.md)
changes an idle existing agent while preserving its identity and state scopes.
Pack instantiation still creates a distinct version-derived agent. A runtime
package deploys one version at a time; active handler retention remains pending.

Execution revisions are server-owned and independent of profile timestamps. The
runtime pins them before admission and rejects a stale pin with
`agent_runtime_revision_conflict`; callers refresh canonical configuration before
submitting a new command. Packages cannot provide or replace the pin through
runtime metadata. Missing legacy pins represent revision zero only. Typed-state
handles retain their original revision and cannot read, write or replay a commit
after authority advances; a newly authorized handle retains the same state scope.
Pending HTTP chat commands pin the revision before acknowledgement and transfer to
a single run atomically. Expired or cancelled commands cannot begin late work.
They expose durable outcomes through the headless API; replay never automatically
repeats model work. See [command admission](chat-command-admission.md).

V2 action bindings explicitly select `simulation` or `external`; omitted v1
targets retain external semantics. The experimental workflow `actions.simulate`
port commits state, decisions and effect/delivery receipts atomically without an
external executor. Durable-step contexts expose this port but no external action
authority. See [simulation contracts and replay](runtime-simulation.md).

Not implemented: remote package installation, arbitrary executable uploads,
package-owned D1 access, pack-supplied migration hooks, trading adapters, or
marketplace distribution. Swordfish remains packaged and intentionally parked.

## Bound external-action approval (experimental)

`ActionProposal.preconditions` optionally declares exact versions of external
state records from the package's declared namespaces/kinds. `expiresAt` can set
an earlier deadline; the platform caps review validity at fifteen minutes.
Approval binds the full proposal, runtime adapter, policy and credential version.
Changed content requires a new proposal/key and review. Exact legacy proposal
replay remains supported; cross-agent key collisions fail rather than returning
another agent's proposal. See [review authority](action-review-design.md).

## Declarative provider operations (experimental)

V2 inline external action bindings may name a reviewed `providerOperation` and
connection instead of package execution/reconciliation callbacks. Approval pins
the operation version, schemas and configured destination. D1 dispatch receipts
precede network mutation; validated provider outcomes precede action projection.
A lost response requires read-only reconciliation, and projection repair reuses
the receipt. See [the contract](provider-operation-contract.md) for input,
authentication, output filtering, lifecycle semantics and acceptance limits.
