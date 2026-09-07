# @operloom/agent-sdk

Build-time contracts for trusted Operloom Agent Packs and Runtime Modules.

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
