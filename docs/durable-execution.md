# Durable execution (implementation in progress)

Existing workflow handlers remain request-bound. V2 bindings can now additionally
provide experimental `durable.execute(input, flow)` orchestration using named
`flow.step` callbacks, `flow.sleep` and `flow.approval`. The native Cloudflare Workflows adapter is
connected behind `WORKBENCH_DURABLE_WORKFLOWS_ENABLED=false`; D1 owns canonical run authority,
submission receipts, step attempts, validated results and operator events. A new
workflow-engine binding is necessary because neither D1 batches nor the existing
request watchdog supply persisted step scheduling or waits.

## Persistence and replay boundary

One scoped submission key identifies one logical run and one persisted engine
identity. New runs use opaque IDs so recreating a deleted workspace cannot reuse
an instance targeted by an old deletion call. Retries look up the unique scoped
submission receipt, preserving both historical IDs and concurrent replay identity.
Recording the run, immutable package/workflow/configuration pins and
startup intent is one D1 transaction. A bounded dispatcher can recover the gap
between this transaction and engine creation by using the same instance identity.
Reusing a submission key with changed content fails. Engine parameters contain
only the run identity; application step returns contain opaque result references.
Native timer checkpoints retain the remaining duration so a replay reuses the
same sleep identity, including deadlines that elapsed during D1 work. Application
inputs and results stay in platform-owned D1 tables for export and deletion.

Named steps have explicit versions, bounded results and an explicit replay-safety
declaration. Starting an attempt and recording its outcome are separate atomic
transactions. A completed result is reused. An interrupted attempt with no outcome
cannot execute again unless the declaration explicitly allows safe replay; its
prior attempt remains visible. Every attempt gets a new identity while the logical
step identity stays unchanged. Declared safe retries are bounded; external actions
with ambiguous outcomes require reconciliation rather than speculative repetition.

Admission and resume recheck current membership, agent revision, configuration,
run authority, kill switches and export fences. Cancellation revokes further work
without deleting committed results. Package upgrades remain fenced by active
runs. Deployment must retain compatible versioned handlers for active runs.

## Deployment compatibility gate

The guarded Worker deployment and standalone deployment command now freeze the
candidate bundle before inspecting active D1 execution pins. Migration 0030 adds
a platform-owned admission fence: existing request leases and tenant write fences
cannot prevent another Worker from admitting a new durable run between inspection
and activation. A database trigger closes that race for older Workers too. The
fence contains only deployment identity, artifact/configuration hash and time;
it contains no tenant records and is outside workspace export/deletion. Verified
activation atomically records the current deployment generation and releases the
fence. Older Workers then fail new admissions even if an edge still routes to
them; runs admitted before activation retain their original execution authority.

The candidate runs locally with its original capability configuration. An
authenticated loopback-only probe resolves each active package/workflow version
and compares its runtime version and definition hash. Disabling a required
capability or removing/changing the handler rejects deployment before upload.
At most 1,000 distinct active pins are inspected, in pages of 100; overflow fails
closed. Existing executions and exact submission replays continue while new
admissions return `durable_deployment_in_progress`. Package authors must version
changes to imported helpers/dependencies too: function serialization is an
additional drift check, not a semantic compatibility proof.

The fence has no automatic expiry. A preflight rejection releases only its own
fence. After an upload attempt, any error retains the fence until the exact
deployment ID and release are observed at `/health/live`. Operator retries use
the original artifact with `--resume <deployment-id>`; `--release <deployment-id>`
only activates and clears a fence after the same live verification. Neither command cancels
active runs or changes their stored pins. A raw provider deployment can bypass
this repository guard and is outside the supported release path.

The compiled helper ships in the standalone artifact and needs only Node and
artifact-local Wrangler. `pnpm run deploy -- --origin https://<worker-origin>`
requires migration 0030 first. For local inspection only, run
`node deploy-durable-runtime.mjs --check --local --persist-to <state> --origin http://127.0.0.1`.
That command briefly fences new admissions but never uploads a Worker. Evidence
under `deployment-evidence/` contains no credentials; temporary probe tokens are
removed after the probe stops. Preserve an uncertain deployment's artifact and
evidence until reconciliation. Hosted activation/recovery remains unverified.

The native runtime must still obey Cloudflare's
[replay and idempotency rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/).
The gate does not replace the hosted deployment/restart acceptance drill.

## Bounded recovery

Recovery extends the existing D1 execution rows with a due time, a leased claim,
retry count and bounded engine-status/error codes. The engine cannot atomically
publish canonical failure or cancellation into D1, so these fields retain the
reconciliation obligation across Worker failures. No additional queue or control
plane is introduced. Each scheduled pass claims at most sixteen due rows, with
four concurrent inspections and five-second provider-call bounds. Claims expire
after 90 seconds and failed inspection backoff is capped at fifteen minutes.
Rows under active export fences are skipped. Failed inspections back
off; expired claims become eligible again. Recovery never restarts a started
instance or repeats a package effect.

Deadline expiry, revoked database authority and confirmed engine termination or
failure close active canonical runs atomically with their intents, unknown step
outcomes and events. Engine completion without canonical completion is a blocked
projection gap, not proof of a successful application outcome. Cancelling a run
revokes authority immediately; recovery separately terminates any surviving
engine instance. Engine payloads, errors and output are not copied into recovery
metadata. Export fences also fence recovery writes.

## Approval pauses (experimental)

A v2 workflow approval checkpoint binds a named/versioned immutable review payload
and an expiry capped by the run deadline. It is a human review gate, not a grant
of tool permissions or external-action authority. Subsequent context, policy and
optimistic state checks remain mandatory.

The existing approval list/decision routes remain the operator interface. A scoped
durable approval record supplies immutable binding, consumption evidence and a
pending native wake intent. This D1 metadata is necessary because publishing an
approval decision and sending a Workflow event cannot share a transaction. Events
contain only the approval identity and are wake signals, never authorization.
Delivery retries with bounded leases/backoff; the engine checks canonical
approval, expiry and live authority before consuming the decision and resuming.
Export/purge include the records. Historical approval decisions remain
readable on replay, and requested approvals cannot run new package steps.

The shared approval-list and run-intervention contracts expose a `review`
descriptor containing payload, request hash and expiry. Web approval views render
that content as text. The document-review workflow optionally requests a review
and links the receipt to its final decision after refreshed evidence/state checks.
Ordinary native approval and denial pass local backend-only conformance; restart
acceptance is recorded separately in the delivery ledger.

## Trigger admission (experimental)

Trigger creation can opt into `execution: "durable"` for a v2 durable binding.
The existing scheduler leases and authenticated webhook routes remain the intake.
A scoped D1 link is necessary to transfer the dispatch lease, pin its trigger
configuration and create the run/startup intent in one transaction. Lease expiry
after transfer cannot fail a healthy durable run. Dispatch identity becomes the
logical event identity; delivery attempts do not create new logical runs.

Pause or material input/configuration changes cancel linked active runs. Runtime
authority checks also require the current trigger configuration, live linked
dispatch and an active owner/admin membership. Terminal run state projects into
the dispatch. Monitor/schedule observations coalesce to one pending occurrence;
manual/webhook ingress is bounded to 100 pending events per durable trigger and
rejects changed content under an existing idempotency key. An already admitted
durable dispatch cannot use the legacy replay path to create a second run.
Migration 0029 includes links in export, restore and purge. Source and standalone
local acceptance cover scheduled execution, webhook deduplication, changed-payload
rejection, approval-pause revocation and lifecycle cleanup. Hosted background
operation and measured backlog recovery remain open.

## Native engine deletion

Native engine creation and D1 publication cannot share a transaction. Migration
0027 therefore adds scoped dispatch receipts before each creation call. Only a
matching successful response marks a dispatch accepted. Lost responses and
process interruption retain uncertainty even when an instance is subsequently
visible. Concurrent creation calls are fenced; acknowledged instances are never
recreated. Historical executions migrate with an uncertain dispatch receipt,
because their old run status cannot establish acknowledgement.
Admissions from older Workers during a rolling deployment receive the same fence
through a database trigger; new admissions explicitly pin the lifecycle protocol.

Workspace purge deletes native instances in batches of 25 using Cloudflare's
[deleteBatch API](https://developers.cloudflare.com/workflows/build/workers-api/#deletebatch).
Each confirmed deletion is recorded before canonical D1 cleanup. Exact native
not-found results permit idempotent retry; arbitrary errors do not. Successful
pages yield to the lifecycle scheduler without consuming failure retries.
Database guards prevent deleting execution identities or dispatch receipts before
native cleanup. Existing export fences cover the new records.

Unsettled or ambiguous creation calls block purge, preserving the identities
needed to investigate a possible late creation. The ordinary purge retry does
not clear this fence. Operator reconciliation for unknown/historical dispatches
and same-commit hosted deletion drills remain acceptance gates. No provider error
payload is persisted and deleting an instance cannot reverse an external effect.

## Integration gates

The D1 kernel and native Workflows adapter now support named/versioned bounded
steps, timer waits, fresh step contexts and atomic terminal result/event projection.
User submissions send `execution: "durable"`, `executionMode: "dry_run"`, nested
`input` and an `Idempotency-Key` header to the existing workflow command route.
Acceptance returns `202` and the canonical run identity without waiting for the
handler. Cron recovers up to 16 pending startup intents using stable engine IDs.
Request-mode v1/v2 execution remains unchanged. Trigger/demo durable admission is
rejected until their lease/quota handoff is implemented.

The compiler accepts durable bindings only in v2 Cloudflare modules. Orchestration
has no effect ports; step callbacks receive bounded cancellation, scoped state,
context, structured models and declared tools. Legacy managed state/events and
action execution are unavailable in this adapter. Use atomic state entries/outbox
for durable decisions and events. Tool policy is rechecked on each invocation.
The engine receives run IDs and caches only D1 result references. Package errors
are converted to bounded error codes before entering engine history.

`runtime.workflow.durable.v2` remains unadvertised until its broader gates pass:
version-retention deployment checks, approval pauses, trigger integration, engine
uncertain-dispatch reconciliation and hosted deletion/interruption acceptance. The current definition pin
includes declared versions and executable function text. It cannot substitute for
a deployment/package integrity gate covering imported implementation dependencies.

### Local engine evidence and limitation

`pnpm conformance:runtime` exercises the actual local engine through HTTP
acceptance, observation, a timer wait, canonical state publication, scheduled
engine termination after cancellation and duplicate/
changed-input submission. `--durable-restart` additionally stops the Worker after
the wait is persisted and starts it against the same storage. That automatic
restart test fails with both Wrangler 4.98.0 / Miniflare 4.20260603.0 and the
updated Wrangler 4.135.0 / Miniflare 5.20260918.0-alpha: D1 and
engine steps/wake time survive, but the emulator does not schedule the wake after
process restart. Its `TimePriorityQueue.handleNextAlarm()` only peeks at the heap.

`pnpm conformance:runtime --durable-restart --local-engine-wake` sends an explicit
local-only wake event after restart. Replay then completes with one attempt per
step and one state version. This proves retained-step replay with a wake stimulus;
it does not prove automatic restart recovery or hosted durability. No production
workaround or automatic engine restart was added. Keep the strict drill and hosted
acceptance gate open. See Cloudflare's [local development documentation](https://developers.cloudflare.com/workflows/build/local-development/)
for the distinction between emulated and hosted execution.

The adapter revalidates handler pins before every resumed operation;
authority checks must not be cached as completed engine steps. Step claims return
an expiry and unique attempt identity. Internal state, context and model/tool
reservation ports now accept server-owned attempt authority. Their D1 admission
receipts validate the active attempt, database-clock expiry, run status, actor,
configuration/handler pins and kill switches atomically with publication. A durable
run cannot use an unfenced legacy port. Cached state/model results also require a
current attempt. Model/tool operation identities include the logical step, so safe
retry reuses the same receipt while another step has a separate operation identity.
Existing request-mode resource identities remain unchanged.

Already-incurred provider/tool usage can settle after attempt expiry; late results
cannot grant the expired callback further authority. This preserves accounting and
reconciliation evidence without authorizing additional work. State evidence and
outbox intents still commit together or not at all. These ports do not yet implement
approved external-action fencing or delegated child execution under a durable step.
The adapter builds fresh contexts with these pins and bounded abort signals.
Each new logical step captures new evidence, including after a timer wait. Retrying
that step retains its immutable capture; expired required evidence blocks replay.
Snapshots have transactionally ordered revisions and stable per-step identities.
A new capture never overwrites an earlier decision's evidence. Packages must
compare refreshed evidence with a saved proposal before applying domain changes;
the document-review example blocks changed content after a wait.
Submission currently records
user-origin dry-run intent; trigger lease linkage and approved external effects
must be added through their canonical authorization paths.

Acceptance includes two concurrent submissions, loss of the HTTP response,
termination between steps, response loss inside a step, cancellation/revocation
before resume, changed handler/version rejection, duplicate webhooks, delayed
approval, deployment restart, quarantine/recovery and final deletion. Local
Workflows acceptance must use the actual engine; an in-memory replay test alone
does not prove durability.

Cloudflare requires deterministic step identities and orchestration, with side
effects inside steps and explicit retry behavior. See the primary
[execution rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)
and [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/).
