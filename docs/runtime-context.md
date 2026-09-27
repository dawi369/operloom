# Scoped runtime context (experimental)

Runtime Module v2 binds its manifest context descriptors to executable resolvers.
The platform supplies the canonical user/workspace/agent scope, invocation input,
a read-only typed-state port and an abort signal. Resolvers receive neither raw D1
nor credentials nor state/effect mutation ports. Packages remain trusted build-time
code; this interface is not a JavaScript sandbox.

Each binding declares a schema, version, timeout and maximum age. Trust and whether
a source is required come from the package manifest, never from retrieved content.
Results carry observation/expiry timestamps and bounded provenance references.
The platform records fresh, stale, missing, invalid and failed sources explicitly.
Required non-fresh evidence blocks the invocation before workflow/model work.
Optional unavailable evidence remains visible. Freshness is checked again before
platform-dispatched tools and writes so a long computation cannot silently use
expired required evidence.

Snapshots are immutable D1 records linked to a workflow or chat run, agent revision,
package/runtime versions, configuration hash (including effective model settings)
and invocation hash. Persistence and
run linkage share a D1 batch with live membership, package, revision, run and
lifecycle preconditions. A replay returns the stored snapshot and does not repeat
resolvers. Recorded data is evidence, not instructions or hidden chain-of-thought.

The existing D1 and lifecycle machinery can persist/export/purge this evidence;
a new storage service is unnecessary. Snapshot limits are 16 sources, 16 KiB per
source and 128 KiB total; source deadlines are at most 5 seconds. Partial snapshots
are never treated as ready. [Structured model calls and budget reservations](runtime-models-and-budgets.md)
recheck required freshness at admission. The
[document-review example](../examples/document-review/README.md) records an
immutable decision referring to its snapshot, and detects unchanged content before
any model call or record write. Its word-count workflow is deterministic; its
separate summary workflow exercises the structured model port and links usage
receipts to decisions.

## Authoring and client contract

Require `context.snapshots.v2`, enable `WORKBENCH_CONTEXT_ENABLED`, and provide a
`context` array on `defineControlPlaneModuleV2`. Each manifest context descriptor's
`runtimeBinding` must match one resolver's `id`. Versions and bounded schemas are
part of the captured contract. State-backed resolvers also require typed state.

Resolvers return either `{ status: "missing" }` or
`{ status: "available", data, observedAt, expiresAt, provenance }`. Expiry is clamped
to `observedAt + maxAgeMs`. Failed/invalid outputs are redacted; resolver exception
text is never stored as context. Resolvers must honor the abort signal. A deadline
ends platform waiting but cannot preempt synchronous trusted JavaScript.

Package handlers receive `context.context.snapshot` and `assertReady()`. The Fetch
client uses `client.context.snapshot(id)`, backed by the shared-schema
`GET /v1/workspaces/{workspaceId}/agents/{agentId}/workbench/context-snapshots/{id}`.
`client.context.list({ runId, runKind, afterRevision?, limit? })` lists capture
metadata through `GET /workbench/context-snapshots`; full evidence loads by ID.
The list is scoped to the authenticated actor/workspace/agent, ordered by revision,
and bounded to 50 metadata rows per page. `nextAfterRevision` advances the cursor.
Snapshot `captureKey`, `revision` and `stepId` are optional for compatibility with
retained historical JSON. The list supplies revision zero for those historical
rows. Workflow history links the latest `contextSnapshotId` and `contextStatus`
to each run; decision records retain the specific evidence they used. Direct
Admin tool calls capture context through the same dispatch boundary before the
tool executes. Missing required evidence ends the current workflow as `blocked`
(HTTP 409); retry creates
a new run and snapshot. Legacy chat retains its failed transport status with a
`context_blocked` error and blocked snapshot. Snapshots are exported and purged
with the workspace; quarantine denies reads and recovery retains the original data.

The snapshot content hash covers source identity, version, status, trust, data and
provenance, excluding observation timestamps. Packages decide whether unchanged
evidence justifies a no-op. A replay of the same logical capture returns its original evidence and
still checks freshness; it does not silently refresh the snapshot. Typed commits
recheck required expiry atomically, while legacy action/tool ports currently check
freshness before dispatch. Stronger external-effect preconditions remain part of
the controlled-effects milestone.

## Durable step captures

The platform captures one immutable snapshot per logical durable step. A new
step after a wait resolves fresh evidence; replay of the same step retains its
original snapshot and rejects stale required evidence. Attempt retries do not
silently replace the evidence used by earlier effects. Request-mode workflows
and chat retain their existing one-capture identity.

Migration 0026 preserves all existing snapshot IDs and JSON, assigns historical
rows revision zero, and replaces the run-only uniqueness constraint with a scoped
capture key plus an ordered revision. This uses the existing D1 evidence table:
run-only uniqueness cannot represent evidence before and after a durable wait.
A transaction assigns revisions and publishes the run pointer and event together.
Durable captures are limited by the run's declared steps (at most 128); the table
also permits one historical run capture. Packages cannot choose a capture key or
snapshot revision. State/model/tool publication continues to check required
freshness inside its authorization boundary.
