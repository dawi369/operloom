# Agent Packs

Agent Packs are the code-first extension boundary for Operloom. A pack
bundles reviewed behavior, declared tools and workflows, user-facing starters,
risk metadata, and verification scenarios. Creating an agent snapshots the
installed pack version into the workspace-scoped D1 agent record.

Document status: Agent Pack API v2 and Runtime Module v2 are implemented for
trusted build-time packages. Remote installation, a marketplace, arbitrary
executable uploads, secret binding, and automatic snapshot upgrades are not
implemented.

## Default and example agents

`config/product.json` (`workspace.defaultAgentPack`, `workspace.maxAgents`)
chooses the pack new workspaces snapshot into their default agent and caps the
number of agents. Upstream, the default is `agent-packs/operloom`, a
conversational pack with no external tools, workflows, connections, or
background triggers; the catalog lists it before the specialist packs.
The agent picker keeps the workspace default first without changing an existing
chat or the user's selected agent.

Untouched legacy WorkOS bootstrap agents named `Default Agent` receive the
Operloom name and snapshot on their next authenticated request. Renamed agents,
custom behavior snapshots, runtime settings, and saved agent choices are
preserved. Other installed pack updates remain explicit version upgrades.

Repository Analyst is the working repository example. Polymancer is a read-only
market research example. Swordfish is a parked architecture preview: its starters
work from supplied context and do not imply live backend access. Stable pack IDs
are retained so existing conversations and artifacts remain associated correctly.

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
      starters: [/* exactly two or four message or workflow actions */],
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

Pack manifests remain serializable snapshots. Adjacent Runtime Module v2
exports provide trusted control-plane, runner, and web implementations. The
deterministic compiler owns forms, schemas, generic routes, policy defaults,
compatibility, health/eval bindings, and renderer lookup; there is no
handwritten workflow catalog or per-workflow Vercel route.

Cloudflare owns workflow orchestration even when a step uses the signed runner.
Runner transport (`cloudflare_inline` or `fly`) is separate tool-call metadata.
Unknown workflow declarations remain inspectable but are not runnable.

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
An authorized operator creates and enables each trigger explicitly, or the
package does it on the user's behalf through `context.triggers.ensure(id)`
(requires the `triggers.ensure` capability). That call installs a declared
schedule or monitor, enabled, for the current agent when the run's user is an
owner or admin; a trigger that is already installed is returned unchanged, so an
operator's pause or disable stands. Use it when a user action starts a process
that needs the trigger, for example tracking a new feed.

Schedule and monitor dispatches use the Cloudflare cron tick. Webhook creation
returns its secret once and persists only the hash; ingress uses a public id,
constant-time secret verification, bounded normalized input, and an idempotency
key. Pack installation never grants credentials, model exposure, trigger
authority, or mutation rights. Validation rejects non-serializable values,
invalid references, duplicate identifiers, and non-positive limits.

### Monitors

Rendered hosted Workers run the scheduled handler every minute, and
`pnpm operloom dev` calls it every minute locally. Monitor intervals are at least 60 seconds.
Each occurrence creates one dispatch; its run sees `context.run.trigger`
(`id`, `packTriggerId`, `dispatchId`, `source`, `scheduledFor`, `attempt`),
which stays the same when that occurrence is retried.

A monitor tick should observe, then no-op unless something changed:

```ts
import { monitorCursorState, monitorFingerprint, observeMonitor } from "@operloom/agent-sdk";

// state: [monitorCursorState("capacity"), ...]
const observation = await observeMonitor(state, {
  namespace: "capacity",
  key: "pool",
  fingerprint: await monitorFingerprint(snapshot),
  observedAt: new Date().toISOString(),
});
if (!observation.changed)
  return { ok: true, output: { outcome: "no_change" }, summary: "Unchanged." };
await state.commit({
  idempotencyKey: `${context.run.trigger?.dispatchId ?? context.run.id}.decision`,
  reads: [...observation.commit.reads],
  writes: [...observation.commit.writes],
  entries: [{ id: `${context.run.id}.decision`, type: "decision", data: { outcome: "escalate" } }],
});
```

The cursor read is versioned, so a concurrent or retried tick for the same
observation conflicts instead of recording a second decision.

### Bundled providers

`@operloom/agent-sdk/providers` ships adapters for common services so a package
binds them instead of writing HTTP code:

```ts
import { calendarReadTool, transactionalEmailOperation } from "@operloom/agent-sdk/providers";

tools: [calendarReadTool({ connectionId: "calendar.primary", adapter: "google-calendar", recorded: sample })],
providerOperations: [transactionalEmailOperation({ providerId: "transactional-email" })],
```

Adapters: calendar (`google-calendar`, `microsoft-graph`), mail (`gmail`,
`microsoft-graph`), geocoding (`nominatim`), routing (`osrm`), news
(`newsapi`), and transactional email and SMS as reviewed provider operations. A read
tool requests `broker://configured/<path>`; the broker resolves it under the
connection provider's configured endpoint and host allowlist, so packages hold
no hosts, client ids or credentials. With a `recorded` sample the tool answers
from it, marked `source: "recorded"`, until the workspace authorizes the
connection. See `examples/service-desk`.

Operations that reach a person take an `outreach` block:

```ts
smsSendOperation({
  providerId: "sms-relay",
  outreach: { dailyCap: 40, window: { start: "09:00", end: "20:00", timezone: "America/Denver" } },
});
```

Both helpers default to `{ dailyCap: 50 }` so a fork cannot ship without a
cap; pass `outreach` to raise it or add a window. The platform checks both
before any provider is contacted: a send outside the
window fails the action with `outreach_window_closed`, and one past the cap
(counted per agent per local day from receipts, including sends still in
flight) with `outreach_daily_cap_reached`. Put the limits here rather than in
the prompt; the model cannot talk its way past them. `smsSendOperation` posts
`{ to, text }` (E.164, 1600 characters) to the operator's relay, which holds
the carrier credentials and the opt-out list and answers `queued`, `sent`,
`rejected` or `opted_out`; the last two fail the action.

### Runner recipes

Tools declared with `transport: "fly"` run in the signed Node runner and receive
`context.recipes` instead of raw `child_process`, `fs`, network or browser
access. Each recipe is bounded by a timeout and a byte cap (clamped to
`recipeLimits` from `@operloom/agent-sdk/runner`), charged against an 8 MiB
per-call budget, redacts secret-looking output, and reports itself through
`context.recipes.usage()`:

| Recipe            | What it does                                                                                                 | Guard rails                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `process`         | spawn a single executable with arguments (no shell) inside the runner workspace                              | command and argument validation, cwd inside the root, minimal env, output cap        |
| `browser`         | fetch a page and extract `title`, text and selector fields; Playwright when installed, plain fetch otherwise | the tool's signed `allowedHosts`, redirects re-checked, third-party requests blocked |
| `repository`      | list a local path or a shallow `git clone` of an `https` URL, with package metadata                          | `rg --files`, secrets and `node_modules` excluded, `maxFiles`                        |
| `document`        | read text, markdown, JSON or CSV from a workspace path or inline text                                        | path inside the root, `maxBytes`, truncation flagged                                 |
| `artifact.upload` | stage an artifact the tool result publishes                                                                  | counted against the budget, surfaces as a staged Fly artifact                        |

Recipes return a status (`completed`, `failed`, `timeout`, `blocked`,
`unavailable`) rather than throwing, so a tool can degrade honestly. See
`operator.page.read` in `examples/complex-operator/runner.ts` and
`agent-packs/repo-analyst/runner.ts` for the pattern. The runner refuses network
targets outside the tool's `sandbox.network.allowedHosts`, so a pack cannot
widen its own egress from inside a recipe.

### Delegation

A run may hand a bounded workflow to another agent in the workspace:

```ts
const { taskId } = await context.tasks.delegate({
  agentId: scoutAgentId,
  workflowType: "territory.scan",
  input: { area },
  deadlineMs: 15 * 60_000,
  idempotencyKey: `scan-${area}`,
});
// on a later run
const task = await context.tasks.result(taskId); // queued | running | succeeded | failed | expired | cancelled
```

Requires `tasks.delegate`. The task is queued, not run inline: the scheduler
leases it on a later tick and runs the workflow as the target agent, which
sees `context.run.delegation` (`taskId`, `parentRunId`, `requesterAgentId`,
`deadlineAt`, `depth`). The target must be an active agent of the same
workspace whose pack declares the workflow as `userInvocable` or `delegable`.
`resourceLimits.maxDelegationDepth` (default 2) caps chains and
`maxDelegationFanOut` (default 4) caps tasks per run; the key is scoped to the
requesting run, so a replay returns the same task and different content
conflicts. Cancelling the requester cancels its queued tasks; a task not
started by its deadline expires. The child's state and budget belong to the
target agent; the requester's history shows the task and the child run.
Delegation is also a plan feature: a workspace whose plan lacks `delegation`
gets `entitlement_required`.

### Entitlements

A pack that declares `entitlements.read` receives `context.entitlements`
(`planId`, `planLabel`, `features`, `seats`, `subscribed`) and can degrade a
workflow by plan instead of failing on a gated call. Plans and their budget
ceilings live in `config/billing.json`; packs never read billing state from
storage. See [headless runtime](headless-runtime.md#plans-and-entitlements).

### Renderers

A package owns how its results look. The manifest declares renderers as data
and the web module supplies components:

```ts
// manifest
artifactRenderers: [
  { artifactKind: "document_review_report", renderer: "module", title: "Review", version: 1, maxBytes: 4096 },
],
toolResultRenderers: [{ toolId: "document-review.record", version: 1 }],

// web.ts
artifactRenderers: { document_review_report: DocumentReviewReport },
toolResultRenderers: { "document-review.record": DocumentReviewRecordResult },
```

The registry (tool id or artifact kind → renderer version and payload bound)
is compiled package metadata every client can read; the web components are one
consumer and a native shell maps the same ids to its own. Components receive
data already in the message, sanitized of credential-like keys and bounded by
`maxBytes` (default 64 KiB); larger payloads and thrown renderers fall back to
the generic JSON view. Renderers must not fetch. `json`, `markdown` and `table`
remain the generic artifact kinds for packages without components.

A package may also ship a `native` subpath (`native.ts` for source entries,
`./native` in `exports` for installed ones) built with
`defineNativeModule` from `@operloom/agent-sdk/native`. It maps artifact kinds
to React Native components and is optional: the compiler emits
`generated/agent-runtime/native.ts` from the packages that have one, each key
must be a declared `artifactRenderers` kind, and the mobile Artifacts tab uses
the component when the sanitized payload is within bounds and its generic
key/value view otherwise. A native module imports `react-native`, so add it as
a `devDependency` of the package for typechecking; packs without a native
module render through the generic view on mobile.

### Status lines

A workflow tells the owner what it is doing with `context.updates.post(text)`
(one sentence; the platform clamps it to 280 characters and stops at 60 per
run). The lines show on the fleet board beside run and approval events. Post
after each meaningful step, with the finding rather than the mechanics: "3 of
12 quotes unanswered past 48h" beats "queried jobs table". Inside the signed
runner the port is a no-op; post from the workflow that invoked the tool.

### Notifications

A package declares the user-facing events it may emit:

```ts
notifications: [
  { type: "capacity.escalated", description: "An allocation needs attention.", defaultChannels: ["email"] },
  { type: "capacity.observed", description: "Folded into the digest.", defaultChannels: ["email"] },
],
```

and requires `notifications.emit`. A run calls
`context.notifications.emit({ type, title, body, target: { type, id }, severity })`.
The platform records a control-plane event and routes it by the user's channel
preferences, falling back to `defaultChannels`; undeclared types are refused.
`alert` is delivered at once, `action` waits out the user's quiet hours, and
`info` is folded with the user's other open items into one digest per channel
at their digest hour (or the next scheduled tick when none is set). The same
event for the same target is delivered once per channel. Packages never see
addresses or transports; locally and in conformance a recorded transport marks
the delivery row delivered.

### Memory

A package that requires `memory.recall` receives `context.memory` in workflow
steps, tool executions and monitor ticks:

```ts
const watching = await context.memory?.list({ kind: "watchlist" });
const record = await context.memory?.remember({
  kind: "conclusion",
  key: `research:${slug}`,
  title: `Research: ${question}`,
  content: { asOf, slug, yesPrice, summary },
  target: { type: "market", id: slug },
});
await context.memory?.forget(record.id);
```

Writes default to `scope: "agent"` (`"user"` for a user-wide record,
`"workspace"` to share with every member, which the platform allows only when
the acting user is an owner or admin), are recorded with `source: "workflow"`
and the run id, and replace an earlier record with the same kind and key.
`list` accepts a `target` to fetch everything about one subject.

The manifest's `memory` block sets how the platform treats what the model and
your workflows write; every field is optional:

```ts
memory: {
  autoActivate: ["note"],                          // the rest wait for the user's tap
  ttlDays: { conclusion: 3, watchlist: 30, note: 14 }, // agent claims fade; null = never
  contentSchema: { conclusion: { type: "object", required: ["asOf", "slug"], ... } },
},
```

Platform defaults activate `note`, `conclusion` and `watchlist` on write and
expire them after 14, 7 and 30 days; `goal` and `preference` always wait for
confirmation and never expire. A package with `risk.financialData: true`
activates nothing by default. User-written records are never subject to TTLs or
proposals. Active records are rendered into the prompt in two piles, "what the
user told you" and "what this agent concluded earlier" (with source and date,
flagged stale past half their life), so keep content small, dated and factual.
The bundled `baby-polymancer` pack is the reference: an empty research query is
steered by the newest watchlist entry, each run remembers a dated conclusion
about the market it looked at, and nothing activates without a tap.

### Settings And Queries

`settings` declares a JSON schema, defaults, and the top-level keys operators
may edit (`GET/PUT /agents/{id}/settings`, owner/admin, versioned). Runs read
the values pinned at admission from `context.settings`; chat receives editable
values as data in the system prompt. `queries` are bounded, read-only
projections for clients (`GET /queries`, `POST /queries/{id}`) that see
`settings` and the `get`/`list` state port for the agent's current effect target.

### Reference loop and ledger pattern

`examples/resource-allocator` is the reference operator loop, registered with
one `workbench.config.ts` entry. Each monitor tick:

1. **Settles** approved allocations. For each open request whose provider
   receipt succeeded, one commit carries `projection: { proposalId }`, the
   append-only ledger entry (`type: "effect"`, id `ledger-<proposalId>`), the
   pool's derived `available` and the request status. The projection identity
   and versioned reads make a replayed tick a no-op.
2. **Observes** the capacity feed context and calls `observeMonitor`; an
   unchanged fingerprint returns `no_change` without writing.
3. Records a cheap `noop` decision below `settings.escalateAbove`, or
   **escalates**: a structured model decision over the evidence, then
   `actions.propose` with a reservation on the pool's `available` field. The
   request record, decision entry and cursor advance commit together.
4. The proposal is `policy_controlled` with one unattended allocation a day:
   the first dispatches inside `propose` and waits for post-hoc review, later
   ones wait for operator approval. Under `simulation` the binding's
   `simulate` returns the provider-shaped receipt; under `external` the
   reviewed `capacity.allocate` provider operation runs.

The `resource-allocator.overview` query serves pools and requests to clients.

Provider operations are declared by the package too. The control-plane
module lists them in `providerOperations` (provider id, auth scheme, method,
endpoint path suffix, schemas, limits and the receipt field mapping) and
requires `actions.provider_operations`; an inline action references one and
the environment binds the provider id to a configured connection provider.
The compiler refuses undeclared references and mismatched connections. See
the SDK README for the declaration shape.

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

`examples/resource-allocator`, `examples/document-review` and
`examples/complex-operator` are registered for conformance and local
development only.

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

The console's instantiate route requires the admin allowlist
(`OPERLOOM_ADMIN_USER_IDS` or `OPERLOOM_ADMIN_EMAILS`). Cloudflare also
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
entry. The starter is deliberately read-only, secret-free, disabled from model
tool use, resource-bounded, and already wired through every seam a product
pack needs: one deterministic read tool and workflow, a monitor trigger (off
by default, 5 minutes, routed to that workflow, which can tell a tick from a
user request through `context.run.trigger`), a `memory` block with nothing
auto-activating and conclusions expiring after two weeks, one workspace
editable setting, a health check per binding, a static eval and a smoke
scenario. The header comment in `index.ts` lists where each seam grows
(connections, renderers, notifications). Replace the placeholder purpose and
the deterministic binding with domain behavior; keep the safe defaults until
the behavior behind them earns more.
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
schema defaults must declare `conformanceInput`. Tool inputs are generated from
`default`, then `enum`, then the first `examples` value; give constrained
fields such as patterns an `examples` entry. The service-boundary command exercises the deployed-shape
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
  idempotency, timeout, and approval policy. `approval: "required"` always
  waits for an operator. `approval: "policy_controlled"` declares
  `policy.limits` and requires `actions.policy_controlled`; a proposal inside
  every limit (`count` per hour/day, `amount` of a preview field per period,
  `allowlist` of a preview field against an agent setting) is dispatched by
  `propose` itself and listed for post-hoc review, while any breach, kill
  switch, policy refusal or settings change since evaluation holds it for the
  normal approval.
- Missing or incompatible runtime workflow bindings remain visible and
  chat-capable but cannot execute.
- Pack results belong in `/history`; raw implementation details belong in the
  allowlisted Admin Diagnostics tab.

See `agent-runtime-kit.md` for the complete executable package boundary and the
Complex Operator golden path.
