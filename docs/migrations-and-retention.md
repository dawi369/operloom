# Migrations, Retention, Export, And Deletion

Document status: current migration contract. Advanced hosted data lifecycle
acceptance remains separate from the [stable 1.0 workbench](release-1.0.md).

## Migration contract

`cloudflare/control-plane/migrations/` is the forward-only D1 ledger. The chain
contains 15 migrations: the `0001` baseline, existing control-plane
changes through `0005`, lifecycle (`0006`), connection brokerage (`0007`),
action authority (`0008`), broker capabilities (`0009`), non-identifying
deletion receipts (`0010`), atomic chat-run claims (`0011`), consistent export
fences (`0012`), manual purge recovery (`0013`), and mobile device delivery
metadata (`0014`), and public-demo usage/budget accounting (`0015`). Do not
rewrite a migration after it is applied.

Current ledger:

1. `0001_initial.sql`
2. `0002_managed_state.sql`
3. `0003_triggers.sql`
4. `0004_trigger_webhooks.sql`
5. `0005_artifact_retention.sql`
6. `0006_customer_data_lifecycle.sql`
7. `0007_connection_broker.sql`
8. `0008_mutation_authority.sql`
9. `0009_connection_capabilities.sql`
10. `0010_nonidentifying_deletion_receipts.sql`
11. `0011_atomic_chat_run_claim.sql`
12. `0012_consistent_workspace_exports.sql`
13. `0013_data_job_manual_recovery.sql`
14. `0014_mobile_delivery.sql`
15. `0015_demo_limits.sql`

`cloudflare/control-plane/schema.sql` is the matching reset snapshot. Its
`DROP TABLE` preamble makes it destructive and appropriate only for deliberate
dev resets. Production rollback is a forward fix.

Required checks and application order:

1. `pnpm db:cloudflare:migrations:verify`
2. encrypted D1/R2 backup and checksums for the target environment
3. apply the migration using the explicit target command documented in the
   environment runbook
4. deploy the matching Worker
5. run same-commit lifecycle and tenant-boundary acceptance

The verifier proves empty application, adoption from the prior baseline, reset
schema parity, retained-row reapplication, migration-ledger integrity, and that
an active export fence blocks new tenant writes until it is released.

## Workspace retention policy

Every workspace receives an unconfirmed privacy-oriented policy:

| Data class                             |  Default |                             Bounds |
| -------------------------------------- | -------: | ---------------------------------: |
| Raw chat messages                      |  90 days |                        1–3650 days |
| Run and tool payloads                  |  90 days |                        1–3650 days |
| Artifacts                              |  90 days |                        1–3650 days |
| Operational events                     |  30 days |                        1–3650 days |
| Runtime traces                         |  14 days |                        1–3650 days |
| Audit, policy, approval, action ledger | 365 days | minimum 365 while workspace exists |

Owners/admins manage and confirm the policy through
`GET/PATCH /workbench/retention-policy`. Mutation remains unavailable until an
owner/admin confirms it. Scheduled sweeps are tenant-policy-aware, bounded,
audited through durable state changes, and safe to retry. R2 objects are deleted
before their D1 metadata is tombstoned.

## Asynchronous export

Owners/admins use:

- `POST /workbench/data-exports`
- `GET /workbench/data-exports/:id`
- `GET /workbench/data-exports/:id/download`

The durable job moves through queued, running, completed, failed, cancelled, or
expired states. Export acquisition freezes tenant Durable Objects, installs a
tenant-scoped D1 write fence, stages D1 rows with keyset pagination, and pins the
matching R2 object set before releasing the bounded fence. Normal writes receive
`423 workspace_export_in_progress` while the fence is active. Reads remain
available. The archive manifest is schema version 3 and records `snapshotAt`,
fence acquisition/release timestamps, D1 collection counts, Durable Object
checksums, explicit security-state omissions, and fence duration so the
consistency guarantee is auditable.

The job publishes only after a complete ZIP is assembled in private R2. The
archive contains a checksummed `manifest.json`, staged D1 NDJSON, the frozen
Durable Object thread state, and the pinned original R2 artifact bodies. Credential
payloads, Vault references, OAuth state, webhook hashes, and other secret state
are omitted. Any missing object or checksum mismatch fails the job rather than
publishing a partial archive. Downloads are private, `no-store`, owner/admin
only, audited, and expire after seven days.

The incomplete synchronous export route is removed. Only the asynchronous job
and private download contract are supported.

## Workspace deletion

The lifecycle is `active → quarantined → purging → purged|failed`.

An owner must provide the exact workspace name and a WorkOS `auth_time` no older
than five minutes. Quarantine immediately blocks normal tenant access, pauses
triggers/webhooks, cancels active runs and approvals, enables the workspace kill
switch, and revokes/deletes Vault credentials. Credential revocation is
irreversible.

For 30 days, only the initiating owner may inspect deletion status or recover.
Recovery restores retained content and access, but not credentials, webhook
secrets, approvals, or enabled triggers. At the deadline, the resumable purge
checkpoints credential, Durable Object, R2, and D1/receipt phases. It removes
Durable Object state before D1 thread identities, then R2 objects, OAuth state,
connection/action state, and remaining tenant D1 rows. Only a non-identifying
deletion receipt remains.

After bounded automatic retries are exhausted, the workspace is `failed` and
the deletion status exposes only the failed phase, stable redacted error code,
attempt counts, and recovery eligibility. The initiating owner may use
`POST /workbench/workspace-deletion/retry` with a fresh WorkOS reauthentication
assertion and exact workspace-name confirmation. The compare-and-set transition
preserves the phase cursor, acknowledges the lifecycle alert, and prevents two
operators from restarting the same job. It never restores credentials or
normal workspace access.

If the initiating owner is unavailable, an allowlisted platform operator may
invoke the signed Vercel-only escape hatch:

```text
POST /api/workbench/admin/workspace-purges/<workspace-id>/retry
{"workspaceName":"<exact name>","reason":"<recorded operational reason>"}
```

The Cloudflare endpoint is hidden unless the signed facade authenticates the
platform-operator assertion. It additionally requires the existing open
critical lifecycle alert and uses the same cursor-preserving CAS transition.
The audit event records operator identity and reason without reading customer
content. Direct Worker or D1 recovery is unsupported.

## Backup and restore

`pnpm db:cloudflare:backup:verify` proves deterministic D1 backup/restore against
an isolated database. Before a hosted migration, create a mode-0600 remote
export, record its SHA-256, environment, commit, operator, timestamp, and table
counts, and restore only into a fresh recovery database. D1 export is not R2 or
Durable Object disaster recovery; release evidence must separately verify those
classes.

## Release evidence

- `pnpm conformance:data-lifecycle`
- fresh-database forward migration and recovery rehearsal
- same-commit D1/R2/DO export, quarantine/recovery, and time-shifted purge
- retention backlog and lifecycle job-failure dashboards/alerts

Legal hold, regulated-industry retention, multi-region replication, and
customer-managed backup destinations remain outside 1.0.
