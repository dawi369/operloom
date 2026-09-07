# Data And State

Operloom needs clear ownership for every kind of state. Summaries are indexes, not truth. Durable state and linked artifacts are the source of truth.

This page maps storage ownership. See `docs/db-contracts.md` for docs-first durable entity contracts and data-client boundaries.

## Storage Map

- Durable Object state or Durable Object SQLite: per-agent hot state, active session state, coordination locks, and wakeup metadata.
- D1: relational app and control-plane data.
- R2: blobs and artifacts.
- Workflow backend: in-flight workflow state for complex execution.

## Canonical Entities

- Tenant scope: `userId` and `workspaceId`.
- User: authenticated person.
- Workspace: work, team, account, or domain boundary.
- Agent: configured assistant instance within a workspace.
- Thread: conversation or task continuity.
- Workflow intent: typed escalation request.
- Run: one foreground, background, workflow, or child execution attempt.
- Decision record: durable reasoning/provenance record.
- Tool definition: registered tool contract and policy.
- Tool call: one execution attempt against a tool.
- Audit event: immutable record of important state changes and actions.
- Artifact: file, log, trace, report, screenshot, export, or bundle.
- Trigger: schedule, webhook, external event, or tool event that can wake work.
- Managed state: domain assets the agent owns or monitors.
- Ledger entry: proposed, executed, skipped, blocked, or reviewed action.

These are canonical platform concepts, not final table definitions. Entity-level contract shapes live in `docs/db-contracts.md`.

## D1 Responsibilities

D1 should hold relational data:

- Users, workspaces, memberships, and roles.
- Agents and configuration.
- Tool registry, permissions, and execution policy metadata.
- Threads, workflow intents, runs, decision records, audit events, triggers, managed state, and ledger entries.
- Artifact metadata and R2 object references.

## R2 Responsibilities

R2 should hold object data:

- Tool logs and traces.
- Generated reports and research bundles.
- Screenshots and browser artifacts.
- Exported ledgers or decision archives.
- Large workflow outputs.

R2 should not be treated as the app database. Store searchable metadata in D1 and blobs in R2.

### Why Workflow Storage Is Not Enough

LangGraph checkpoints and executor-local files belong to an execution attempt.
They do not provide the workspace-scoped authorization, retention, export, and
deletion boundary required for customer-owned outputs. Canonical artifacts
therefore use D1 metadata plus a Cloudflare-mediated R2 object key. This keeps
the lifecycle independent from a specific workflow engine and prevents Fly or
an Agent Pack from acquiring broad storage credentials.

The Worker configuration declares the `ARTIFACTS` R2 binding. Wrangler supplies
an isolated local preview bucket for development and Level 3 conformance; each
hosted environment must explicitly provision the named bucket before deploy.
Blob creation and deep health fail closed when the binding is absent. The
workbench does not silently fall back to D1, local disk, or a public URL.

## Workflow Backend Responsibilities

Workflow engines may keep in-flight execution state, retries, checkpoints, and intermediate step state. Final important outputs must be written back to canonical D1/R2-backed state so the conversational agent can explain them later.

## Access Pattern

Cloudflare should mediate application data access for workflow and tool execution first.

Fly/LangGraph services should receive a scoped workflow context, then use a data client with operations such as:

- Load workspace context.
- Read decision records.
- Create or supersede decision records.
- Append audit events.
- Create artifact metadata.
- Patch managed state.
- Record ledger entries.

The data client enforces `userId + workspaceId`, permissions, redaction, and audit. Initially it is backed by mediated Cloudflare APIs.

Future optimization: the backing implementation may switch to scoped direct D1/R2 access only for proven hot paths. That must not change the workflow-facing API or bypass tenant checks, redaction, or audit events.

## Pack-Owned Domain State

Agent Packs do not create an alternate persistence boundary. A pack may declare
namespaced managed-state, decision, artifact, and view descriptors from the
target contract in `capability-model.md`. The generic workbench renders those
descriptors through shared list, detail, filter, history, and action surfaces.

Cloudflare still derives scope and mediates reads and writes. Domain fields stay
in namespaced extension data until repeated use proves they belong in a shared
entity contract. Pack upgrades that change retained shapes require explicit,
forward-compatible migrations before automatic snapshot upgrades are allowed.
