# Agent Packs

Agent Packs are the code-first extension boundary for Operloom. A pack
bundles reviewed behavior, declared tools and workflows, user-facing starters,
risk metadata, and verification scenarios. Creating an agent snapshots the
installed pack version into the workspace-scoped D1 agent record.

The complete target composition boundary is defined in
`capability-model.md`. API v2 implements serializable extension descriptors and
the subset of runtime bindings that can be validated and enforced today.

Document status: Agent Pack API v2 and Runtime Module v1 are implemented for
trusted build-time packages. Remote installation, a marketplace, arbitrary
executable uploads, secret binding, and automatic snapshot upgrades are not
implemented.

## Contract

Define a pack with `defineAgentPack()`:

```ts
export const examplePack = defineAgentPack({
  id: "example-analyst",
  name: "Example Analyst",
  description: "Bounded analysis over trusted read-only tools.",
  profile: "analyst",
  version: "1.1.0",
  capabilityLevel: "single_agent_app",
  format: "xml",
  folderPath: "agent-packs/example-analyst",
  codePath: "agent-packs/example-analyst/index.ts",
  promptPath: "agent-packs/example-analyst/prompt.xml",
  tools: [
    {
      id: "example.lookup",
      invocation: "workflow",
      required: true,
      executionModes: ["dry_run"],
      modelVisibleDefault: false,
      purpose: "Return bounded evidence for the example workflow.",
    },
  ],
  workflows: [
    {
      type: "example.research",
      engine: "cloudflare",
      status: "declared",
      userInvocable: true,
      description: "Run bounded example research.",
    },
  ],
  ui: {
    primarySurface: "workbench",
    inspectorSections: ["prompt", "tools", "history"],
    configurationMode: "code",
    welcome: {
      title: "Example Analyst",
      description: "Choose a focused starting point.",
      starters: [
        /* exactly two or four message or workflow actions */
      ],
    },
  },
  risk: {
    financialData: false,
    externalMutation: false,
    requiresSecrets: false,
    productionGate: "none",
  },
  connections: [
    {
      id: "example.public-data",
      provider: "example",
      principal: "none",
      credentialClass: "none",
      custody: "none",
      required: true,
      toolIds: ["example.lookup"],
      scopes: [],
    },
  ],
  context: [
    {
      id: "example.evidence",
      trust: "retrieved",
      description: "Bounded evidence returned by the registered adapter.",
      required: true,
      runtimeBinding: "example.lookup",
    },
  ],
  managedState: [],
  triggers: [],
  artifactRenderers: [
    { artifactKind: "example_report", renderer: "json", title: "Example report", version: 1 },
  ],
  healthChecks: [],
  evals: [],
  compatibility: { packApi: 2, minimumWorkbenchVersion: "0.5.0" },
  resourceLimits: {
    maxRunSeconds: 30,
    maxToolCallsPerRun: 4,
    maxConcurrentRuns: 1,
    maxArtifactBytes: 131072,
  },
  smokeScenarios: [],
  prompt: examplePrompt,
});
```

`defineAgentPack()` adds `apiVersion: 2`, `kind: "agent_pack"`, and the derived
template id `pack-<id>`. Versions must be semantic. The adjacent `prompt.xml`
must match the inline prompt exactly.

Pack manifests remain serializable snapshots. Adjacent Runtime Module v1
exports provide trusted control-plane, runner, and web implementations. The
deterministic compiler owns forms, schemas, generic routes, policy defaults,
compatibility, health/eval bindings, and renderer lookup; there is no
handwritten workflow catalog or per-workflow Vercel route.

The manifest engine must match the registered workflow binding. `cloudflare`
means Cloudflare owns orchestration even when a step uses the signed Fly runner.
`langgraph` is persisted only after delegation creates a real LangGraph run and
records its external run id. Runner transport (`cloudflare-inline` or `fly`) is
separate tool-call metadata. Unknown workflow declarations remain inspectable
but are not runnable.

Runtime workflow `label` text names the launcher action. The optional
`runDisplayName` supplies a stable History label when that surface needs
different copy; both values remain compiled package metadata rather than core
application conditionals.

Each tool declares who invokes it:

- `user`: a direct tool exposed to the operator surface.
- `agent`: a conversational tool the model may select when policy allows it.
- `workflow`: an internal adapter used only inside a bounded workflow.

Workflows remain separate, explicit user actions. The normal **Tools** panel and
`/tools` command show runnable workflow launchers, agent-only tools, and
workflow-internal adapters for the current agent without conflating them.

## API v2 Extension Descriptors

API v2 declares typed context sources, namespaced managed state,
schedules/webhooks/monitors, artifact renderers, health checks, eval mappings,
compatibility bounds, and resource ceilings. These remain data and are
snapshotted with the behavior template. Executable callbacks live only in the
environment-specific Runtime Module exports and are visible through
`agent-packs:inspect`.

Declarations remain inert until trusted platform code supplies a runtime
binding and workspace policy allows it. Managed-state descriptors now bind to
the generic tenant-scoped managed-state repository. Schedule, monitor, and
webhook descriptors can bind to registered checked-in workflows through the
Cloudflare trigger repository and dispatch runtime. They must remain disabled
by default; installing or activating a pack does not create or enable a trigger.
An authorized operator creates and enables each trigger explicitly.

Schedule and monitor dispatches use the Cloudflare cron tick. Webhook creation
returns its secret once and persists only the hash; ingress uses a public id,
constant-time secret verification, bounded normalized input, and an idempotency
key. Pack installation never grants credentials, model exposure, trigger
authority, or mutation rights. Validation rejects non-serializable values,
invalid references, duplicate identifiers, and non-positive limits.

Connection descriptors are part of Pack API v2. They bind declared tools
to a provider, principal, credential class, scopes, required/optional posture,
and either `none` or `external_broker` custody. Credentialed descriptors use the
platform broker: WorkOS Vault stores values, D1 stores metadata and opaque
references, OAuth uses Authorization Code + PKCE with single-use state, and
refresh uses a D1 lease/CAS. Runtime code receives only a tool-scoped brokered
request capability whose provider host is allowlisted. No Pack, model, callback,
artifact, export, trace, log, or Fly envelope receives raw credentials.

Pack-owned descriptors compose into generic workbench surfaces. They do not add
unscoped routes, arbitrary executable uploads, domain tables, or private
navigation forks. State uses namespaced extension data until a repeated shape
earns a shared platform contract.

## Bundled Packs

| Product name        | Stable pack id    | Workflow                     | Artifact kind            |
| ------------------- | ----------------- | ---------------------------- | ------------------------ |
| Repository Analyst  | `repo-analyst`    | `repo.readiness_report`      | `repo_readiness_report`  |
| Polymancer Research | `baby-polymancer` | `polymancer.market_research` | `market_research_report` |
| Swordfish Runtime   | `baby-swordfish`  | parked                       | none                     |

Repository Analyst calls the signed Fly `repo.snapshot` adapter and produces a
bounded repository-readiness report. It also declares disabled-by-default
schedule and webhook bindings for that same read-only workflow. Polymancer
Research uses public no-auth Polymarket discovery, snapshot, and CLOB reads.
Swordfish keeps activation, profile, prompt, welcome, and chat behavior but
declares no executable runtime surface while its backend is parked.
Runnable pack workflows persist workflow, tool-call, audit, event, and artifact
metadata through the common Cloudflare lifecycle.

## Versioning And Activation

Pack-backed agents are immutable snapshots:

- Existing agents keep their prompt, pack metadata, and version.
- Updating a checked-in pack does not silently update an agent.
- Admin **Use pack** reuses an active agent only when pack id and version match.
- Otherwise Cloudflare creates one deterministic managed instance for that
  workspace, pack, and version using an idempotent insert.
- Activation starts a fresh chat and leaves the current thread unchanged.

The Vercel activation facade requires the operator allowlist. Cloudflare also
requires active workspace `owner` or `admin` membership. `/agents` remains the
normal member-facing switcher for existing agents.

## Welcome Actions

The active pack snapshot supplies the empty-chat title, description, and either
two or four starter actions so the grid never renders an orphaned card. Message
actions use the normal optimistic composer path.
Workflow actions open the existing bounded workflow dialog. Cached session
metadata renders these immediately while the live Worker connection completes
in the background. Legacy and non-pack agents use the generic welcome.

## Adding A Pack

Start with the conservative Pack API v2 scaffold:

```bash
pnpm agent-packs:create --id trade-watcher --name "Trade Watcher" --dry-run
pnpm agent-packs:create --id trade-watcher --name "Trade Watcher"
```

The command validates the id/name before writing, refuses to overwrite an
existing directory or configuration entry, creates the manifest,
control-plane, runner, web, package metadata, prompt exports, package-local
README, and characterization test, and adds the single `workbench.config.ts`
entry. The starter is deliberately
read-only, secret-free, disabled from model tool use, resource-bounded, and
equipped with a static eval and health declaration. Replace its placeholder
purpose and replace the deterministic starter binding with domain behavior.
Add connection descriptors before introducing a provider-backed tool. A
credentialed descriptor does not become usable until the platform provider
module, connection health, retention confirmation, workspace enablement, and
policy all agree.

Then:

1. Refine the generated manifest and prompt together.
2. Implement its schemas and handlers in `control-plane.ts` or `runner.ts`;
   do not add a core route or registry entry.
3. Keep model exposure off until policy explicitly allows it.
4. Add report-derivation, authorization, retry, artifact-preview, resource-bound,
   and input-bound tests.
5. Run:

```bash
pnpm agent-packs:validate
pnpm agent-packs:compile --check
pnpm agent-packs:inspect --pack <pack-id>
pnpm agent-packs:smoke --pack <pack-id>
pnpm agent-packs:test --pack <pack-id>
pnpm workbench pack check --pack <pack-id>
pnpm conformance:agent-system
pnpm test:service-boundaries
pnpm verify:fast
```

Use `--json` on the pack scripts when integrating them into automation.
`agent-packs:smoke` is a static manifest/compiled-registry mapping smoke; the separate
`agent-packs:test` executes package health/eval bindings and every executable
generic workflow in an isolated context. Required workflow inputs without
schema defaults must declare `conformanceInput`. The service-boundary command exercises the deployed-shape
local runtime. Live
provider smokes remain explicit and are never triggered by local validation.

## Safety Rules

- Never put tenant ids, credentials, private endpoints, provider headers, or
  customer-specific policy in a pack.
- Declaring a tool does not make it model-visible. Cloudflare policy and active
  pack scope must both allow exposure.
- A tool's invocation class is descriptive, not an authorization bypass. User,
  agent, and workflow calls still require a registered runtime binding and
  Cloudflare policy approval.
- Packs declare credential classes but never contain credential values.
- Execute-mode tools require external mutation risk, a production gate,
  proposal/result schemas, a compatible action executor, connection identity,
  idempotency, timeout, and approval policy.
- Missing or incompatible runtime workflow bindings remain visible and
  chat-capable but cannot execute.
- Pack results belong in `/history`; raw implementation details belong in the
  allowlisted Admin Diagnostics tab.

See `agent-runtime-kit.md` for the complete executable package boundary and the
Complex Operator golden path.
