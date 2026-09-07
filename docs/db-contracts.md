# DB Contracts

Operloom uses docs-first DB contracts before adding migrations or storage
implementations. These contracts define durable entity shapes and repository
operations, not final D1 table schemas, SQL migrations, or stable public APIs.

There is intentionally no parallel provisional TypeScript entity or data-client
layer. Shipped records are typed beside their owning Cloudflare repositories
and facades. This document stays a target vocabulary until a repeated,
implemented boundary justifies a shared public contract.

The goal is to define the data shapes the platform must preserve across
Cloudflare, Fly, LangGraph, and future app-specific bots without locking the
repo into premature storage details.

## Contract Rules

- Tenant-owned records are scoped by `userId` and `workspaceId`.
- The model never supplies tenant scope; auth, session, or trusted trigger
  context derives it.
- Shared fields stay small and boring.
- TypeScript contracts are serializable records, not runtime objects with
  executable functions.
- App-specific fields go in `data?: Record<string, unknown>` until repeated
  usage proves they belong in the shared core.
- Status fields are used only for real lifecycle state.
- Large logs, traces, screenshots, reports, and exports are stored as artifacts,
  not embedded in relational records.
- Summaries are indexes, not truth. Durable state, provenance, and artifacts are
  the source of truth.

Common scoped shape:

```ts
type ScopedRecord = {
  id: string;
  scope: {
    userId: string;
    workspaceId: string;
  };
  createdAt: string;
  updatedAt?: string;
  data?: Record<string, unknown>;
};
```

## Durable Entity Shapes

The TypeScript names in this section are provisional code-facing names. They
describe serializable records the platform must preserve, not table names.

### UserRecord

Authenticated person who can own or join workspaces.

Minimum fields:

- `id`
- `displayName`
- `email`
- `createdAt`
- `updatedAt`
- `data`

### WorkspaceRecord

Operational boundary under an operloom account source. In B2B
deployments, the account source is usually a WorkOS organization. The current
slice creates one default workspace per account source; the north star allows
multiple workspaces per account later. Workspaces isolate tools, secrets,
memory, ledgers, triggers, agents, and artifacts.

Minimum fields:

- `id`
- `accountId`
- `accountSource`
- `name`
- `isDefault`
- `createdByUserId`
- `createdAt`
- `updatedAt`
- `data`

### MembershipRecord

User-to-workspace relationship. Authorization checks should use membership
records before touching scoped data.

Minimum fields:

- `id`
- `userId`
- `workspaceId`
- `role`
- `status`
- `createdAt`
- `updatedAt`
- `data`

Suggested statuses: `active`, `invited`, `disabled`.

### AgentRecord

Configured assistant instance inside a workspace. A workspace may have multiple
agents for different domains, personalities, tools, or operating modes.

Minimum fields:

- `id`
- `scope`
- `name`
- `description`
- `status`
- `createdAt`
- `updatedAt`
- `data`

Suggested statuses: `active`, `paused`, `archived`.

### ThreadRecord

Conversation or task continuity container. Threads are where users return to
ask what the agent is doing, why it did something, or what it is waiting on.

Minimum fields:

- `id`
- `scope`
- `agentId`
- `title`
- `status`
- `createdAt`
- `updatedAt`
- `lastActivityAt`
- `data`

Suggested statuses: `open`, `waiting`, `archived`.

### WorkflowIntentRecord

Typed escalation request from conversation, schedule, webhook, or another
trusted event. Runtime routing is policy/config, not a stored runtime target.

Minimum fields:

- `id`
- `scope`
- `agentId`
- `threadId`
- `stage`
- `type`
- `execution`
- `status`
- `payload`
- `relatedDecisionIds`
- `createdAt`
- `updatedAt`
- `data`

Suggested statuses: `queued`, `running`, `interrupted`, `completed`, `failed`,
`cancelled`.

### RunRecord

Runtime control record for one foreground, background, workflow, or child
execution attempt. It represents the hosted control-plane equivalent of a
session/run object, not a transcript artifact.

Minimum fields:

- `id`
- `scope`
- `agentId`
- `threadId`
- `workflowIntentId`
- `status`
- `execution`
- `stage`
- `relation`
- `engine`
- `externalRunId`
- `currentInterruptId`
- `heartbeatAt`
- `lastEventAt`
- `cancelledAt`
- `completedAt`
- `failedAt`
- `failureSummary`
- `toolCallIds`
- `artifactRefs`
- `decisionRecordIds`
- `ledgerEntryIds`
- `createdAt`
- `updatedAt`
- `data`

Suggested statuses: `queued`, `running`, `waiting`, `interrupted`,
`completed`, `failed`, `cancelled`.

`relation` carries parent/child execution metadata such as `parentRunId`,
`rootRunId`, `depth`, and whether a child is allowed to outlive the parent.

`engine` and `externalRunId` link to workflow-engine state such as a LangGraph
run, Fly tool-runner job, or future control-plane execution backend. Important
durable outputs still live in framework records: audit events, tool calls,
artifacts, decision records, ledgers, and managed state.

### DecisionRecordEntity

Durable reasoning/provenance unit. It captures what the agent believes or
decided, why, what evidence supports it, and what supersedes it.

Minimum fields:

- `id`
- `scope`
- `agentId`
- `title`
- `summary`
- `thesis`
- `status`
- `provenanceRefs`
- `artifactRefs`
- `relatedDecisionIds`
- `createdAt`
- `updatedAt`
- `data`

Suggested statuses: `active`, `superseded`, `rejected`, `stale`, `archived`.

### ToolMetadataRecord

Durable metadata for a tool the platform knows about. This is not the same as
runtime `ToolDefinition`, because runtime definitions contain executable
functions.

Minimum fields:

- `id`
- `name`
- `description`
- `kind`
- `version`
- `status`
- `createdAt`
- `updatedAt`
- `data`

Suggested statuses: `available`, `deprecated`, `disabled`.

Tool metadata may be global. Tool enablement, permissions, credentials, and
policy are tenant-scoped.

### ToolPermissionRecord

Tenant-scoped enablement and policy attachment for a tool.

Minimum fields:

- `id`
- `scope`
- `toolId`
- `agentId`
- `execution`
- `status`
- `createdAt`
- `updatedAt`
- `data`

Suggested statuses: `enabled`, `disabled`, `pending_review`.

### ToolCallRecord

One execution attempt against one tool. Tool calls should record enough detail
to audit what happened without leaking secrets or embedding huge outputs.

Minimum fields:

- `id`
- `scope`
- `toolId`
- `workflowIntentId`
- `agentId`
- `threadId`
- `execution`
- `status`
- `inputSummary`
- `outputSummary`
- `error`
- `artifactRefs`
- `startedAt`
- `finishedAt`
- `data`

Suggested statuses: `started`, `succeeded`, `failed`, `cancelled`, `timed_out`.

### AuditEventRecord

Immutable record of important platform, workflow, or tool activity. Audit
events should be append-only.

Minimum fields:

- `id`
- `scope`
- `actor`
- `action`
- `target`
- `summary`
- `createdAt`
- `data`

Suggested actor types inside `actor`: `user`, `agent`, `workflow`, `tool`,
`system`.

### ArtifactMetadataRecord

Searchable metadata for a blob stored in R2 or another artifact store.

Minimum fields:

- `id`
- `scope`
- `kind`
- `uri`
- `title`
- `mimeType`
- `sizeBytes`
- `createdBy`
- `createdAt`
- `data`

R2 stores the object. D1 stores metadata, ownership, and relationships.

### TriggerRecord

Schedule, webhook, external event subscription, or tool event that can wake an
agent or workflow.

Minimum fields:

- `id`
- `scope`
- `agentId`
- `type`
- `status`
- `targetWorkflowType`
- `execution`
- `lastTriggeredAt`
- `nextTriggerAt`
- `createdAt`
- `updatedAt`
- `data`

Suggested statuses: `active`, `paused`, `disabled`.

### ManagedStateRecord

Domain asset the agent owns, watches, or explains. One app may store positions;
another may store services, dossiers, documents, tickets, or tracked resources.

Minimum fields:

- `id`
- `scope`
- `agentId`
- `type`
- `name`
- `status`
- `summary`
- `artifactRefs`
- `createdAt`
- `updatedAt`
- `data`

### LedgerEntryRecord

Durable record of a proposed, simulated, executed, skipped, blocked, or reviewed
action. Ledgers are generic action records, not tied to one app category.

Minimum fields:

- `id`
- `scope`
- `agentId`
- `workflowIntentId`
- `toolCallId`
- `type`
- `status`
- `summary`
- `decisionRecordIds`
- `artifactRefs`
- `createdAt`
- `data`

Suggested statuses: `proposed`, `simulated`, `executed`, `skipped`, `blocked`,
`reviewed`, `failed`.

## Storage Ownership

- Durable Object state or Durable Object SQLite: hot per-agent coordination,
  active stream/session state, wakeup metadata, and locks.
- D1: relational control data, tenant records, tool registry, permissions,
  decisions, audit events, ledgers, triggers, managed state, and artifact
  metadata.
- R2: blobs, reports, logs, traces, screenshots, exports, and large tool
  outputs.
- Workflow backend: in-flight workflow/checkpoint state. Important final
  outputs must be written back to canonical D1/R2-backed state.

## Policy References

The early runtime contract keeps policy small:

```ts
type ExecutionPolicy = {
  mode: "ask" | "dry_run" | "execute";
  policy?: string;
};
```

The optional `policy` value should be treated as a reference to policy
configuration, not as the whole policy body. Approval gates, limits, cooldowns,
kill switches, allowlists, denylists, and review rules belong behind that
reference.

Full policy record schemas are deferred until implementation proves the fields
they need.

## Data Client Boundary

Cloudflare-mediated APIs are the initial backing implementation for app-state
reads and writes. Workflows, Fly runners, and LangGraph services should use
repository-style operations instead of raw tables.

The target data-client boundary has these rules:

- Every method takes trusted `scope` as the first argument.
- Inputs exclude storage-owned fields such as `id`, `scope`, and timestamps
  unless the operation is explicitly updating an existing record.
- Outputs return durable entity records owned by their platform repository.
- The interface does not imply HTTP paths, D1 tables, migrations, R2 object key
  layout, or Cloudflare/Fly implementation classes.

Repository groups:

- `workspaceContext.load(scope, input?)`
- `decisions.create(scope, input)`
- `decisions.list(scope, filters)`
- `decisions.supersede(scope, input)`
- `workflowIntents.create(scope, input)`
- `workflowIntents.updateStatus(scope, input)`
- `runs.create(scope, input)`
- `runs.updateStatus(scope, input)`
- `runs.list(scope, filters)`
- `toolCalls.recordStarted(scope, input)`
- `toolCalls.recordFinished(scope, input)`
- `audit.append(scope, input)`
- `artifacts.createMetadata(scope, input)`
- `artifacts.createUploadUrl(scope, input)`
- `managedState.get(scope, input)`
- `managedState.patch(scope, input)`
- `ledger.append(scope, input)`
- `ledger.list(scope, filters)`

Data-client implementations must enforce tenant scope, permission checks,
redaction, and audit behavior. The backing implementation may later move from
mediated Cloudflare APIs to scoped direct D1/R2 access for proven hot paths, but
workflow code should not need to change because it depends on these repository
interfaces.

Storage implementation details are intentionally deferred. Do not add table
names, SQL migrations, D1/R2 bindings, Cloudflare Worker handlers, or Fly
service clients to satisfy this contract layer.

## App Extension Model

Operloom stays generic by keeping shared fields small and putting app
fields in `data`.

Examples:

- Market app: `marketId`, `positionId`, `walletAddress`, `maxExposure`.
- Deployment app: `repo`, `commitSha`, `environment`, `serviceName`.
- Research app: `sourceSetId`, `citationStyle`, `reviewCadence`.
- Ticketing app: `issueId`, `priority`, `team`, `sla`.

When the same field appears across multiple app types and affects framework
behavior, it can be promoted from `data` into a shared contract in a later
version.

Reference mappings:

- `docs/reference-apps/polymancer.md` maps markets, positions, trade proposals,
  triggers, ledgers, tool calls, and decision records into these generic
  entities.
- `docs/reference-apps/deployment-agent.md` maps CI failures, services, deploy
  proposals, rollback actions, logs, audit events, and decision records into the
  same generic entities.
