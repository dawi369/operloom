# Migrations, Retention, Export, And Deletion

Document status: current migration contract. Advanced hosted data lifecycle
acceptance remains separate from the [stable 1.0 workbench](release-1.0.md).

## Migration contract

`cloudflare/control-plane/migrations/` is the forward-only D1 ledger. The chain
contains 32 migrations: the `0001` baseline, existing control-plane
changes through `0005`, lifecycle (`0006`), connection brokerage (`0007`),
action authority (`0008`), broker capabilities (`0009`), non-identifying
deletion receipts (`0010`), atomic chat-run claims (`0011`), consistent export
fences (`0012`), manual purge recovery (`0013`), and mobile device delivery
metadata (`0014`), public-demo usage/budget accounting (`0015`), and experimental
typed state, commit receipts, indexes and outbox intents (`0016`), and bounded
state schema migrations with writer fencing and replay receipts (`0017`), and
reviewed partial-migration repair history and receipts (`0018`), and execution
revision admission fencing (`0019`), and pending chat command admission, deadlines
and durable outcomes (`0020`), and explicit package upgrade history/receipts
and validation fencing (`0021`), immutable scoped context evidence (`0022`), and
resource budget policies, reservations and receipts (`0023`), and internal durable
execution submissions, steps, attempts and outcomes (`0024`), and leased engine
reconciliation with retry metadata (`0025`), and ordered immutable context captures
per durable step (`0026`), engine dispatch/deletion receipts (`0027`) and durable
approval decisions, consumption and wake intents (`0028`), and atomic durable
trigger links and authority fencing (`0029`), and a platform durable-admission
deployment fence (`0030`), bound external-action reviews (`0031`), and independent
provider operation receipts (`0032`). Do not
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
16. `0016_runtime_state.sql`
17. `0017_runtime_state_migrations.sql`
18. `0018_runtime_state_migration_repairs.sql`
19. `0019_agent_execution_revisions.sql`
20. `0020_chat_command_admission.sql`
21. `0021_agent_package_upgrades.sql`
22. `0022_runtime_context.sql`
23. `0023_runtime_usage.sql`
24. `0024_durable_execution.sql`
25. `0025_durable_recovery.sql`
26. `0026_context_captures.sql`
27. `0027_durable_engine_lifecycle.sql`
28. `0028_durable_approvals.sql`
29. `0029_durable_trigger_links.sql`
30. `0030_durable_deployment_fence.sql`
31. `0031_action_reviews.sql`
32. `0032_provider_operations.sql`

Migration 0032 stores provider dispatch identities and validated outcomes before
action projection. Resolved results are immutable except for deadline-qualified
payload pruning; uncertain dispatches retain evidence and cannot be reclaimed
for another mutation. Receipts export without credential-version references,
respect workspace export fences and are removed by workspace purge.

Migration 0031 adds scoped review hashes, expiry and immutable authority bindings,
plus database-enforced action transition preconditions. Historical unbound
approvals cannot dispatch; cancel or deny them and create a new proposal. Reviews
participate in export fencing and workspace purge. Terminal review/proposal
payloads may be pruned only after the canonical retention deadline; identities
and hashes remain. Pending, executing and unknown outcomes retain their payloads.

Migration 0029 pins durable trigger configuration and links each admitted dispatch
to one run. Its triggers enforce pause/configuration revocation, terminal dispatch
projection and pending-observation coalescing. Link records export by `run_id`,
respect workspace write fences and are removed during canonical workspace purge.

Migration 0030 adds platform deployment metadata and an admission trigger. This
metadata contains no tenant payload and is not removed by workspace purge. A fence
survives process interruption until its owning deployment is reconciled; it does
not expire automatically or revoke existing runs. Activation records the current
deployment generation atomically; a server-owned immutable deployment ID on new
execution rows blocks stale Worker admissions after release.

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

## Durable recovery migration

Forward migration 0025 adds recovery scheduling, lease and bounded status metadata
to the existing durable-execution rows. It changes no run, submission, package or
provider identity. Closed execution pins remain immutable; only recovery metadata
may change while the system confirms engine termination. These columns share the
existing execution-table export, write fences, restore and workspace purge path.
Apply the migration before deploying the recovery scheduler. Removing a native
engine instance remains a separate lifecycle gate; deleting its D1 row alone is
not proof of complete engine-state deletion.

## Context capture migration

Migration 0026 replaces the context table's run-only uniqueness constraint with
scoped capture identity and revision uniqueness. It copies every historical ID,
request hash and snapshot JSON unchanged before replacing the old table and
restoring indexes, immutability and export fences. Historical rows use capture
key `run` and revision zero; durable step captures use server-selected identities.
The migration changes no package, agent, run or provider resource identity.
Take the required target backup and apply this migration before enabling the
matching runtime. Local verification covers retained snapshot preservation,
fresh migration, schema parity and restore; hosted backup/restore remains a gate.

## Native engine lifecycle migration

Migration 0027 adds scoped creation-dispatch receipts and an immutable native
engine deletion confirmation to each execution. D1 guards require confirmed native
cleanup before deleting execution identities and dispatch receipts. Historical
executions receive an `outcome_unknown` dispatch receipt: older run status is not
proof that every creation request settled. Those records need operator
reconciliation before purge; normal purge retries cannot remove this fence.
An admission-version marker and database trigger also fence old-worker admissions
that arrive after migration during a rolling deployment.

Native deletion runs in pages of 25, retaining per-instance progress across job
retries and final D1 rollback. Missing native instances count as deleted only for
the exact supported not-found response. Unavailable bindings, malformed responses,
provider failures and unsettled dispatches preserve canonical records. Export and
restore include these records and confirmations. Hosted acceptance remains open.

## Durable review migration

Migration 0028 adds scoped immutable review requests, canonical decisions,
consumption receipts and leased wake intents. Database triggers project approval,
run, workflow and audit/event state atomically. Export fences cover all writes;
workspace export and purge include the new table. Denial, expiry and cancellation
revoke continuation while preserving decided review evidence. All 28 migrations
pass local application, adoption, upgrade, parity and backup/restore checks.
