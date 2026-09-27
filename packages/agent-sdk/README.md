# @operloom/agent-sdk

Build-time contracts for trusted Operloom Agent Packs and Runtime Modules.

Experimental v2 `actions.simulate` commits a complete proposal, exact read
versions, state writes, decisions and validated result into a server-selected
simulation scope with atomic effect/delivery receipts. It is available in workflow
and durable-step contexts when enabled. Simulation bindings declare
`action.target: "simulation"` and contain no external executor or credentials.
Persist the plan before a durable commit; retry its original content after an
acknowledgement loss. See [simulation contracts](../../docs/runtime-simulation.md).

The package contains no workbench database, authentication, deployment, or
credential implementation. Runtime code receives scoped capabilities from the
workbench and cannot select tenant identity or bypass policy.

## Public exports

```ts
import { defineWorkbenchConfig } from "@operloom/agent-sdk";
import { defineAgentPack } from "@operloom/agent-sdk/manifest";
import { defineControlPlaneModule } from "@operloom/agent-sdk/control-plane";
import { defineRunnerModule } from "@operloom/agent-sdk/runner";
import { defineWebModule } from "@operloom/agent-sdk/web";
```

`pnpm build` emits Node-compatible ESM and declarations under `dist`. The packed
artifact contains only `dist`, JSON schemas, package metadata, and this README;
consumers do not execute repository TypeScript source.

The SDK is a trusted build-time contract and is initially unpublished. It does
not support remote installation or unreviewed executable uploads.

## Runtime Module v2 (experimental)

`defineControlPlaneModuleV2` opts a control-plane module into explicit backend
version and capability requirements. v1 modules retain their existing contract
through an adapter. `requireRuntimeState(context)` supplies declared, scoped
record reads, indexed lists and atomic optimistic commits when the deployment
enables `state.atomic.v2`. Every write requires an explicit read version; receipts
bind the idempotency key to the complete payload. Packages never receive SQL.

`context.snapshots.v2` binds manifest context sources to versioned, bounded
resolvers with canonical scope and read-only state. Chat and workflows capture
schema-checked evidence; required unavailable or stale sources block work.
Handlers inspect `context.context.snapshot`; typed commits recheck expiry atomically.

`models.structured.v2` and `usage.reservations.v2` expose the experimental
`context.models.structured({ idempotencyKey, prompt, outputSchema, maxOutputTokens })`
workflow port. The backend selects the model, reserves workspace/run capacity and
persists validated public output and usage. Exact successful replay returns the
stored result; ambiguous calls retain their charge and are never automatically
resubmitted. Provider credentials and endpoints are not package inputs.

V2 request handlers remain compatible. An experimental optional `durable` binding
adds named `flow.step` callbacks and `flow.sleep` through the gated native Workflows
adapter. Step callbacks receive scoped ports; orchestration must be deterministic
and perform no I/O outside steps. The full `runtime.workflow.durable.v2` capability
is not yet advertised: hosted restart, handler retention, approval waits and engine
deletion remain acceptance requirements. See `docs/durable-execution.md` in the
source repository.

## Package shape

A package is registered once in `workbench.config.ts` and exports four stable
subpaths:

| Export            | Contents                                            | Loaded by                   |
| ----------------- | --------------------------------------------------- | --------------------------- |
| `./manifest`      | JSON-safe Pack API v2 identity and declarations     | compiler and snapshot layer |
| `./control-plane` | Cloudflare-safe tools, workflows, health, and evals | Cloudflare Worker           |
| `./runner`        | Node/Fly tool adapters                              | signed runner gateway only  |
| `./web`           | trusted artifact and managed-state renderers        | Next.js                     |

Every runtime export declares the same `packId`, `runtimeVersion`, and
`compatiblePackVersions`. The compiler rejects missing providers, collisions,
schema mismatch, incompatible current manifests, and Cloudflare imports of Node
runner implementations.

Create a complete local package with:

```bash
pnpm operloom pack create --id my-agent --name "My Agent"
pnpm install
pnpm operloom pack compile
pnpm operloom pack check --pack my-agent
```

The generated package contains a local README and characterization test. The
complete framework path is documented in `docs/complex-agent-golden-path.md`.

## Execution context

Tool and workflow handlers receive `AgentExecutionContext`, never a database,
Worker `Env`, authentication headers, or provider credentials:

| Capability                  | Contract                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `scope`                     | immutable platform-selected user, workspace, and agent identity                      |
| `pack` / `run`              | immutable runtime, workflow-intent, execution-mode, and source identity              |
| `signal`                    | cancellation signal; durable publication authority is still enforced by the platform |
| `tools.invoke()`            | schema- and policy-checked invocation of a declared tool                             |
| `managedState.upsert()`     | tenant-scoped compare-and-set state write                                            |
| `connections.resolve()`     | scoped provider request capability; never credential material                        |
| `actions.propose/execute()` | durable proposal and policy-controlled action authority                              |
| `events.append()`           | scoped compact runtime evidence                                                      |

Return a `RuntimeResult` instead of throwing for expected domain failures:

```ts
return {
  ok: false,
  error: {
    code: "market_unavailable",
    message: "The requested market is unavailable.",
    retryable: true,
    redacted: true,
  },
  summary: "Market evidence could not be loaded.",
};
```

Thrown exceptions represent adapter or programming failures. The platform
redacts and records them; package code must not place secrets or raw provider
payloads in error messages.

## Schemas and artifacts

Inputs, outputs, proposals, and action results use the Runtime Module v1 JSON
Schema subset. Declare `type` at every level. Supported enforcement includes
object `properties`, `required`, `additionalProperties: false`, array `items`,
`enum`, string length/pattern, and numeric minimum/maximum. Unsupported or
malformed definitions fail compilation.

Successful results can publish bounded artifacts:

```ts
return {
  ok: true,
  output: { status: "ready" },
  summary: "Readiness analysis completed.",
  artifacts: [
    {
      kind: "readiness_report",
      title: "Readiness report",
      mimeType: "application/json",
      data: { status: "ready" },
    },
  ],
};
```

Artifact count and size, tool calls, run duration, and concurrency are bounded by
the manifest and runtime binding. A cancelled or terminal run cannot promote
late tool output, artifacts, state writes, or another terminal event.

## Connections and mutations

Agent Packs declare requirements but cannot grant themselves authority.
Credentialed provider access must use `ConnectionPort`; Fly receives a
short-lived broker capability rather than a credential. Mutation-capable tools
must declare dry-run and execute modes, proposal/result schemas, a connection,
stable idempotency, timeout behavior, approval posture, and reconciliation for
ambiguous outcomes.

Installation alone enables none of those capabilities. Retention confirmation,
connection health, deployment and workspace gates, kill switches, policy, and
approval are enforced outside package code.

## Compatibility and verification

One runtime version is deployed per package. Historical incompatible snapshots
remain chat-capable but workflows return `runtime_incompatible` until the agent
is explicitly upgraded.

Use the focused loop while authoring:

```bash
pnpm workbench pack inspect --pack my-agent
pnpm workbench pack check --pack my-agent
```

Before integrating a platform-boundary change, also run:

```bash
pnpm conformance:agent-system
pnpm verify:fast
pnpm test:e2e
```

## Reviewed state migrations (experimental)

V2 modules declare `stateMigrations` and require `state.migrations.v2`. Declare
both source and destination schemas. Plans support bounded top-level `set`,
`default`, `remove`, and collision-checked `rename` operations; packages receive
no SQL or database migration privilege. Admin API commands pin the plan, fence
incompatible writers, rebuild indexes in bounded transactional batches, and
retain replay receipts. Enablement shares the backend typed-state feature flag.

Durable step contexts capture fresh evidence for each logical step, including the
first step after a wait. Retries reuse that step's original immutable snapshot;
expired required evidence blocks execution. Optional snapshot `captureKey`,
`revision` and `stepId` fields identify these captures while retaining compatibility
with historical snapshots. Record snapshot IDs with decisions and compare refreshed
evidence against observations saved by earlier steps before applying domain effects.

Experimental durable workflows can call `flow.approval({ key, version, summary,
payload, timeoutMs })` between steps. Keys identify immutable review checkpoints;
changing the payload or version during replay fails closed. Payloads are bounded
to 32 KiB, expiry to seven days and the enclosing run deadline. The returned
receipt contains `id`, `requestHash`, `decidedAt` and `decidedByUserId`; link it to
your recorded decision. A review checkpoint grants no tool or external-action
permission. Refresh evidence and recheck state versions before committing.
The runtime persists the decision and resumes through an authenticated native
event; packages never interpret event payloads as approval authority.

External `ActionProposal` values may supply `preconditions` with declared typed
state read versions and `expiresAt` for an earlier deadline. Platform reviews
are valid for at most fifteen minutes and bind complete proposal/runtime/policy/
credential evidence. Changed content or state requires a new proposal and
approval. Simulation plans use their own `state.reads`; these external review
fields are excluded from `RuntimeSimulationCommit`.

## Provider operations (experimental)

A Runtime Module v2 inline external action can declare
`providerOperation: { id: "capacity.allocate", version: "1" }` with a declared
`connectionId`, required approval, and proposal/result schemas. It supplies no
`action.execute` or `action.reconcile` callback. The approved preview is the
operation input; the platform chooses the request identity and credential. V1
callback actions remain supported. The backend flag
`OPERLOOM_PROVIDER_OPERATIONS_ENABLED` defaults to false. Registry installation
is a reviewed platform change; packages cannot register signing handlers.

The initial capacity-service contracts and remaining acceptance gates are in
[provider operations](../../docs/provider-operation-contract.md).
