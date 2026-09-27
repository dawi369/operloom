# Typed runtime state

The existing managed-state table provides individual writes, without a pack read
port or atomic domain operation. Extend the existing D1 database with generic
scoped records, commit receipts, immutable entries and delivery intents. No new
database, queue or volume is required. Packages receive a typed port and never
receive SQL, D1 bindings or migration privileges.

Each agent/package identity has a server-derived scope. Package version is not
part of the scope, so an explicit upgrade retaining agent/package identity
retains state. An unrelated agent obtains a different scope. Simulation and
external state use distinct server-selected scope suffixes.

Every write requires a matching explicit read version (zero means absent).
The first statement in a D1 transactional batch inserts a receipt whose CHECK
constraint asserts all read versions and live workspace/membership/agent state.
A failed assertion aborts the batch, including records, immutable entries and
delivery intents. Receipt uniqueness serializes duplicate keys; replay verifies
the payload hash before returning the stored result. No affected-row check is
used as a substitute for rollback.

Bounds: 32 read versions/writes, 16 immutable entries, 16 delivery intents,
64 KiB total commit payload; list pages at most 100 records. Schema declarations
and equality indexes are platform validated. Lifecycle exports include each
table; export fences and deletion include every record and receipt. The existing
scheduler delivers up to 100 event intents per tick into the canonical event
stream. Event insertion and delivery acknowledgement share a batch; replay cannot
duplicate the event. Revoked or quarantined scopes remain pending. After eight
publication failures, an intent is retained as failed. No additional queue
service was introduced.

## Operator API

The canonical `/workbench/state/records`, `/entries`, and `/deliveries` operations
are available through the scoped public API and the existing signed facade.
Every query requires `target=simulation` or `target=external`; records additionally
require `namespace` and `kind`. The backend derives package scope from the agent's
saved snapshot, so reading historical state does not require an executable handler.
Pages are limited to 100 and cursors are bound to scope, resource and filters.
Active user, workspace, agent and membership are checked in the read query.

Owners/admins can POST `/workbench/state/deliveries/{id}/retry` with `target` and
the observed `expectedAttempts`. Only a failed delivery can transition to pending.
The transition and audit event share a D1 transaction that rechecks membership,
role and the agent snapshot. Export fences roll back both. Attempts remain
monotonic: after the initial eight failures, each explicit retry grants one
additional attempt. Concurrent or stale retry commands receive a conflict and
must refresh canonical state. The event identity never changes; no external
provider operation is dispatched by this endpoint.

These operations share schemas with the Fetch client and generated OpenAPI.
Local tests cover revoked authority, concurrent retry, export rollback, cursor
isolation and eventual publication without duplicating the original event.

## Bounded schema migrations

V2 packages can declare `stateMigrations` with a stable ID, namespace/kind,
source/destination versions and reviewed `set`, `default`, `remove`, or `rename`
operations on top-level fields. Both schema versions must remain declared.
The compiler rejects missing versions, unsafe fields, unsupported operations and
unbounded plans. Commands accept a registered ID, never SQL or executable code
supplied by a client. Schemas, indexes and transformations are pinned in D1.

The schema head fences writes to the affected kind while records remain readable.
`advance` transforms at most 16 records and 64 KiB per command. Records, index
replacement, version increments, progress, replay receipt and audit share a D1
batch. CHECK preconditions enforce live admin authority and expected versions.
A failed statement rolls back the batch, following
[D1 transaction semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/).
Repeated advancement of the same revision returns its stored receipt. Interruption
between commands can resume using canonical progress. Finishing activates the
destination schema head; old writers cannot create records at the previous version.
Unindexed reads can inspect both versions during migration; destination-index
queries only include rebuilt rows.

Migration 0017 adds schema heads, pinned jobs and step receipts because a request
deadline cannot migrate an unbounded record set. Existing D1 supplies durability
and transactions; no additional service is introduced. Exports, write fences and
workspace deletion include these tables. Historical plans can advance even when
their executable package handler is no longer installed.

## Repairing a partial migration

An invalid transformation leaves its batch unchanged and keeps the writer fence.
An owner/admin can select another registered, reviewed migration declaration via
`POST /workbench/state/migrations/{id}/repair`, supplying `replacementId`,
`expectedRevision`, `idempotencyKey` and the state target. A request cannot supply
operations. The replacement must preserve both schema versions, their definitions
and indexes, and the affected namespace/kind. Its plan ID must differ from the
currently pinned plan.

Repair preserves the logical migration ID, cursor, processed count, completed
records and writer fence. Only the unprocessed suffix uses the replacement.
The revision advances atomically with a receipt, both full plans and an audit
event. Concurrent advance/repair commands cannot both win the same revision.
Reusing a command key with different content fails; an identical replay returns
its original receipt even after completion. `planId` identifies the currently
pinned declaration; it is optional in historical receipts.

Migration 0018 retains repair provenance and receipts in existing D1, with the
same export, deletion and write-fence coverage. This is a forward repair, not a
rollback of completed transformations. Correcting already transformed records
requires a later reviewed schema migration. Domain correctness remains the
package author's responsibility.

This remains experimental. Resumable-workflow handler retention, complete
deletion acceptance and hosted recovery evidence remain required.

## Agent execution revisions

Typed-state ports capture the server-resolved agent execution revision. Reads,
commit receipts and commit preconditions check it; an old handle cannot be
silently rebound to new authority. Revision changes preserve the state scope
because the scope derives from user, workspace, agent, package and target, not
the generation. New handles can read the retained records under their declared
schemas. Migration `0019` adds the revision column and run admission/resumption
fences. Legacy identities and signed claims without a revision represent zero.

The [explicit package upgrade command](package-upgrades.md) now archives immutable
snapshots and validates destination schemas, indexes and trigger workflows. Pending HTTP chat commands now participate
in revision fencing before a run exists; see [chat admission](chat-command-admission.md). Do not manually increment a revision as a substitute for
that command. Current SQL prevents changes while runs, schema migrations or
unresolved actions remain active, and migration `0020` covers pending chat
commands. Migration `0021` adds snapshot history, command receipts, queued-dispatch
fencing and a database-maintained validation revision for concurrent state writes.
