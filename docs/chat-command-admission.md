# Chat command admission

Thread-local receipts prevent duplicate message acceptance, but a receipt in a
Durable Object cannot participate in a D1 package-upgrade transaction. Register
pending commands in the existing D1 database before acknowledging HTTP acceptance.
No additional database, queue or service is needed. The existing scheduler bounds
recovery work; this is an admission and evidence mechanism, not resumable execution.

The sequence is D1 reservation, durable transcript, D1 acceptance, local receipt,
then detached execution. Reservations pin authenticated scope, payload hash and
agent revision. D1 run insertion checks the accepted command and transfers it to
running in the same transaction. Each command may own only one run. Terminal run
updates finish the command and publish a durable event atomically. Generation
changes reject pending commands, including reservations not yet acknowledged.

The stores do not share a transaction. A crash between steps preserves the D1
reservation and blocks an upgrade. A bounded deadline closes abandoned work as
failed, and the database then rejects late run insertion. Replaying a key never
automatically repeats provider work; callers inspect the command and explicitly
submit a new key after reviewing a failure. Historical local-only receipts retain
their duplicate semantics. Records contain hashes and identities, not prompts or
credentials; they follow workspace export, quarantine and deletion.

Transactions rely on [D1 batch rollback semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/).
Cloudflare Workflows remains required for resumable model and tool execution.
