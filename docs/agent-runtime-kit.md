# Agent Runtime Kit

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
snapshot. A runtime package deploys one version at a time.

Not implemented: remote package installation, arbitrary executable uploads,
package-owned D1 access, pack-supplied migration hooks, trading adapters, or
marketplace distribution. Swordfish remains packaged and intentionally parked.
