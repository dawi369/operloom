# Explicit package upgrades (experimental)

An upgrade changes the installed package snapshot of one existing agent. It keeps
its agent identity, threads and server-selected state scopes. Instantiating a
package continues to create/reuse the existing version-specific managed identity;
it never upgrades another agent implicitly.

Owners/admins choose the exact installed version, expected execution revision and
an idempotency key. The server resolves the trusted registry entry, negotiates its
runtime requirements, and validates retained typed records and indexes in every
user/target scope. Migrate incompatible records using reviewed state migrations
before upgrading. Existing trigger inputs must still match a retained workflow.

D1 is sufficient for this command: a transactional batch stores the original and
replacement snapshots (including destination declarative runtime contracts), changes the execution revision, and writes a receipt and
audit/event records. Database preconditions reject revoked authority, changed
snapshots, active work and changes during validation. This follows
[Cloudflare's batch rollback guarantee](https://developers.cloudflare.com/d1/worker-api/d1-database/).
No new service or package-controlled SQL is needed.

A database-maintained validation revision changes when records, indexes, schema
heads or trigger definitions change. The final transaction checks this revision,
so preflight validation cannot race a write. Active runs, pending chat commands,
state migrations, unresolved actions and pending trigger dispatches block upgrades.
Completed historical executions retain their original metadata.

Validation reads 16 records per page, with a maximum of 10,000 records and 32 MiB
across the agent's scopes per request. Exceeding a bound rejects the command
without changes; resumable upgrade validation for larger installations remains a
follow-up. Trigger validation is limited to 1,000 definitions. Snapshot/history writes are limited to 256 KiB per snapshot. Index
changes require a reviewed migration, even if the record's data still validates.

History and receipts are immutable until workspace purge, included in workspace
exports and unavailable during quarantine. Same-key replay returns the original
receipt even after another upgrade, subject to current admin authority. Reusing a
key for another payload fails. A retry with a new key and stale revision fails.

This interface does not retain executable JavaScript for old package versions.
Upgrades therefore require idle execution; deployment-time handler retention for
resumable workflows remains part of the durable-execution milestone.
