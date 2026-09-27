# Action resource reservations and projection

Status: implementation in progress; provider operations remain experimental.

## Why additional platform records are needed

Review-bound state versions detect changed evidence, but two approved actions can
read the same unchanged capacity before either projects its result. Neither the
existing state commit receipt nor the provider receipt records that capacity is
temporarily claimed. Add bounded D1 reservation and projection records alongside
these existing records. No new service, package SQL or migration authority is
introduced. [D1 batches](https://developers.cloudflare.com/d1/worker-api/d1-database/)
roll back the whole transaction when a database precondition fails.

## Contract

A v2 named-provider proposal may declare up to eight `reservations`, each naming
a declared external typed-state record, exact version, top-level integer capacity
field and positive integer amount. The package defines what the field and amount
mean; domain correctness remains its responsibility. Reservations are included
in the immutable proposal/review hash and imply exact-version state preconditions.
No URL, scope override or executable predicate is accepted.

The broker claims every resource in the same batch as final dispatch admission
and its provider receipt. Database triggers require current capacity minus all
held claims to cover the new amount. Failure rolls back every claim, receipt and
admission transition before any network call. Ordinary state updates cannot lower
a capacity field below outstanding holds or remove its record. Pending holds fence
agent upgrades and relevant schema migrations so they cannot strand projection.

An ambiguous outcome keeps its holds indefinitely pending reconciliation; elapsed
time, cancellation and kill switches do not prove that an external effect failed.
A recorded provider rejection releases holds atomically with that outcome.
Successful submission keeps holds until the package projects the result.

`state.commit` accepts optional `projection: { proposalId }` for an external
provider result. The platform verifies matching tenant/agent/package, terminal
provider receipt and live state authority. A succeeded operation with held claims
must write each resource field to its current value minus the held amount.
Projection identity, claim settlement, typed writes, immutable entries and event
intents commit together. A failed write preserves all holds and leaves projection
repairable. One proposal has one projection; the original commit key replays its
receipt, while a different projection attempt conflicts. No projection dispatches
a provider operation. A pending external resource may be projected as pending;
ongoing provider lifecycle observation remains separate work.

Reservation/projection identities participate in scoped export, quarantine,
recovery and deletion. Payload retention must preserve unresolved proposal input
until its held resources are projected. Simulations cannot claim external capacity
or project an external provider receipt.

## Acceptance

Prove competing claims, multi-resource rollback, uncertain-outcome retention,
confirmed-failure release, exact debit, duplicate projection, state-write failure,
revoked authority, export fences, schema/upgrade fences and lifecycle deletion.
Exercise the same interfaces with the registered non-financial capacity fixture
through native D1 and the public API before claiming local acceptance.
