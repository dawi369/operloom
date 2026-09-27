# Simulation action commits

Experimental Runtime Module v2 simulation bindings use `target: "simulation"`.
The backend must enable both `WORKBENCH_SIMULATIONS_ENABLED` and
`WORKBENCH_TYPED_STATE_ENABLED`; hosted defaults remain disabled.
V1 action bindings without a target retain their external semantics. V2 action
bindings must explicitly select `simulation` or `external`.

## Authority and persistence

`context.actions.simulate(plan)` accepts a declared workflow tool, schema-checked
proposal and result, exact state read versions and writes, decision entries,
and an idempotency key. The server chooses the simulation scope and adds the
effect evidence, delivery intent and receipt. All commit in the existing typed
state D1 transaction. No new service or persistence table is required.
This relies on [D1 batch rollback semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/);
authority is enforced by the receipt's database CHECK before any dependent writes.

The transaction rechecks membership role, current tool permission, workspace,
package and tool kill switches, active execution/attempt, state versions, schema
heads and required evidence freshness. A conflict leaves every record and entry
unchanged. It never substitutes the current state version for the submitted one.

Simulation bindings have no executor, connection, reconciliation callback or
provider credentials. The compiler rejects these fields; external proposal and
dispatch paths reject simulation bindings. Current simulation bindings use
`dry_run` and inline transport. Approval-bound simulations and external effects
remain separate, unfinished delivery gates. A durable review checkpoint does
not itself grant effect authority.

## Replay and package authoring

An identical plan with the same tool/key and execution/evidence identity returns
the original receipt. Changed content fails with `idempotency_conflict`.
Receipts, state, decisions, effects and delivery intents use the existing scoped
export, quarantine, recovery, upgrade and deletion lifecycle.

For durable work, persist the proposed transition in one step before committing
it in a second step. Revalidate evidence without recomputing read versions.
If a commit succeeds but its step acknowledgement is lost, retry the same plan
in the same logical step. Recomputing against the newly written state would
change the request and correctly conflict. Expired or revoked authority still
blocks work; replay is not a bypass.

The document-review `document-review.simulate` workflow demonstrates both request
and durable invocation. Its durable form saves the proposal, rechecks document
content, and records state, decision and effect atomically. The workflow and
receipts require no frontend library.

This port records simulated effects only. It does not prove provider submission,
external reconciliation, approval expiry or payload binding, reservation across
external operations, or projection repair. See [delivery evidence](runtime-delivery-status.md).
