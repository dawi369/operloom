# Bound external-action reviews

The existing proposal and approval rows do not retain a reviewed payload hash,
expiry or typed-state preconditions. Application-side checks cannot prevent a
concurrent policy/state change between validation and a transition. Durable
Workflows alone cannot supply this database authority.

Migration 0031 adds immutable, scoped action-review records in D1 and a
CHECK-backed guard on the existing action ledger. Review creation and approval/
dispatch admission begin with database-enforced preconditions in the same batch
as their dependent records. This preserves the existing Cloudflare authority;
no new service or package-owned SQL is introduced.

Review bindings pin the full proposal, runtime/action adapter, agent revision,
tool permission, credential reference/version and explicit external-state read
versions. Reviews expire after at most fifteen minutes, or an earlier package
deadline. Membership, kill switches, retention, current policy and state are
rechecked at approval and dispatch. A changed binding needs a new proposal and
approval. Old evidence is retained; historical pending approvals without a bound
review cannot dispatch and must be cancelled (or denied while pending) and recreated.

The external action's admission is the authority boundary. Revocation cannot
undo an already accepted external effect. Provider response ambiguity,
reconciliation, reservations and projection repair remain separate requirements.
Thrown dispatch errors and invalid success results are recorded as
`outcome_unknown` without raw exception text. An explicit adapter failure remains
`failed`; adapters must only use that outcome when rejection is known. Unknown
outcomes cannot be dispatched again through the execution command.
Completion and verification are recorded in [delivery evidence](runtime-delivery-status.md).

After a terminal action reaches its configured payload-retention deadline,
the platform may replace proposal and review payloads with a pruning timestamp.
Database triggers enforce this narrow exception; review hashes and identities
remain. Pending, executing and outcome-unknown actions retain their payloads.
