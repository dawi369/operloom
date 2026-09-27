# Runtime delivery evidence

This ledger tracks the approved [runtime roadmap](implementation-roadmap.md).
The eight-milestone plan is not complete. New capabilities remain experimental
and disabled by default. Historical release evidence does not cover these edits.

## Baseline and compatibility

The pre-existing freshness, progressive-history, model-default, pack-outcome and
documentation changes are preserved. Their focused baseline passed 26 assertions
across six suites. Local-session browser acceptance passed five applicable tests
(progressive history, archived chat refresh and accessibility); four tests for
other authentication/demo modes were intentionally skipped. An alternate runner
port preserved the existing service on port 3101.

Runtime Module v2 metadata, compiler dispatch, v1 adaptation and explicit
backend-version/capability negotiation are implemented. Existing v1 packages and
snapshots retain their identities. Separate v1 and v2 tarball consumers install,
import and compile through external-package registration. SDK and client
contract snapshots have been updated. The compatibility milestone has local
acceptance; neither new package version has been published.

## Implemented locally

- The opt-in `/v1` Worker API verifies WorkOS JWT signature, exact issuer,
  expiration and authorized client claims. Canonical membership and role checks
  remain in the existing authorization handlers. Client identity headers are
  discarded and commands specify explicit workspace/agent targets.
- The local token adapter requires explicit flags, local environment and loopback.
  `pnpm dev:runtime` starts the supervised Worker without Next or web callback
  configuration. `pnpm runtime:bundle` emits an independent Worker deployment
  artifact with copied migrations and stable resource identities; dependency
  auditing rejects frontend packages and unresolved package imports. Direct WorkOS hosted authentication remains unverified.
- Fetch commands, token renewal, neutral transcript blocks, SSE replay/reset,
  polling, cancellation and reconnect are implemented. Chat contracts generate
  runtime validation and OpenAPI schemas; legacy administrative routes still need
  complete shared request/response schemas.
- Chat acceptance uses thread-local durable receipts independent of transcript
  pruning. Reusing a key with different normalized text fails. Receipts are
  exported/purged with the thread; the 10,000-command bound fails closed rather
  than evicting identities. Legacy turns obtain receipts when replayed while
  still retained. This is not resumable model execution.
- Typed state supplies declared schemas/indexes, scoped reads and atomic
  optimistic commits. Records, immutable decision/effect entries and event
  intents share a D1 batch with database-enforced preconditions and hashed receipts.
  The existing scheduler publishes state events and acknowledges them atomically,
  bounded to 100 intents per tick. Failed intents are retained after eight attempts;
  owners/admins can request one additional attempt using the observed attempt count.
  Scoped records, decision/effect entries and delivery status are available through
  shared-schema API and Fetch client operations. Retry and audit commit atomically,
  rechecking live authority and respecting export fences. This is event publication, not a
  completed external notification-delivery guarantee.
- Declarative state migrations pin reviewed transformations and both schemas.
  Bounded batches atomically update records/indexes, cursor, replay receipts and
  audit. Database schema heads fence old writers and activate the destination
  version only on completion. The public API and Fetch client expose list/start/
  advance; a historical saved plan can resume without an installed package handler.
- Owners/admins can repair a partial migration using another registered plan with
  unchanged schemas/indexes. Completed state and the write fence remain intact;
  revision, full plan history, idempotent receipt and audit commit atomically.
- Server-owned execution revisions now pin canonical identities, signed chat
  claims, run admissions and typed-state handles. D1 rejects stale insert/resume
  attempts atomically and rejects revision changes while runs, migrations or
  unresolved actions are active. Legacy pins map to revision zero. This does not
  alone supply handler retention for active durable executions.
- Pending HTTP chat commands now register in D1 before acknowledgement and block
  revision changes before execution starts. Run insertion links one command and
  updates its status atomically; terminal updates publish durable command events.
  The API/Fetch client exposes outcomes, and bounded expiry/cancellation fences
  late work. Cross-store crashes preserve evidence without automatic provider replay.
- Explicit package upgrades now retain the same agent and state scopes, archive
  immutable snapshots and declarative runtime metadata, validate retained records,
  indexes and trigger inputs, and atomically commit revision, receipt and audit/event
  records. Database validation revisions reject concurrent writes. Active execution
  and pending dispatches block upgrades. Validation is bounded to 10,000 records/32 MiB;
  larger installations need resumable validation before this gate is complete.
- Scoped context resolvers now serve workflow, chat and direct Admin tool paths.
  Immutable, schema-checked snapshots record trust, provenance, freshness and
  package/runtime/configuration identity. Required missing/stale sources block
  work; typed commits check evidence expiry in the transaction. Publication
  rechecks active authority, cancellation, kill switches and export locks.
  The document-review package records deterministic word counts and no-op decisions
  with evidence references, without model calls or frontend dependencies.
- Structured workflow model calls reserve workspace/root-run capacity before using
  the configured model and validating output. Exact successful replay returns the
  retained result; ambiguous outcomes remain charged and are never automatically
  dispatched again. Chat provider steps and tool dispatches use the same admission
  boundary when usage enforcement is enabled. Admin APIs expose versioned policy
  updates and paginated usage metadata. Settlement events and receipts commit
  atomically. Provider-reported tokens, estimates and fixture usage remain distinct.
  The document-summary example links usage to decisions and makes no additional
  model call when evidence and effective configuration are unchanged.
- An internal durable-execution store now atomically creates canonical run/startup
  identities, pins package/workflow/configuration, records named step attempts and
  validates immutable result receipts. Interrupted unsafe attempts become unknown;
  explicitly safe attempts have bounded retries with distinct attempt identities.
  Cancellation closes the startup intent and prevents further publication. This
  store now has a gated native Workflows adapter and `202` command path with
  fresh step contexts, timer waits and atomic terminal projection. Full durable
  capability negotiation remains gated pending broader acceptance.
- Forward migrations 0016–0026, reset-schema parity, export fences and workspace purge
  cover every typed-state table. Chat purge explicitly deletes stale message rows.
  Complete chat SDK transient-storage teardown still needs its purge acceptance drill.

## Local verification

- `pnpm verify:fast`: SDK v1/v2 consumers, client consumer, contract snapshots,
  extension conformance, architecture, migration adoption/upgrade/parity,
  local D1 backup/restore, 558 tests across 133 suites, typecheck and lint.
  The complete aggregate passed after formatting and API error-metadata corrections.
- `pnpm build`: passed under supervision.
- Local-session release/accessibility browser suite: five passed, four skipped.
- `pnpm conformance:runtime`: real local Worker/D1; local authentication,
  explicit thread creation, Node and independent-browser submission without a
  realtime prerequisite, transcript/reconnect, duplicate/conflicting replay,
  forged-target denial, policy-bound inline-tool approval and canonical run history,
  completed export and checksum-verified ZIP download, quarantine read denial and
  recovery retaining transcript/command identity. The extended local journey also
  verifies typed-state/decision inspection, simulation/external scope isolation,
  failed-delivery retry and typed-state quarantine/recovery using persisted fixtures.
  It starts no Next process and makes no model-provider call. The complete
  journey now also passes against standalone bundle `bundle-sWVdsA`, including
  durable command/run identity, explicit package upgrades and snapshot recovery,
  migration resume and approval at a nonzero agent
  execution revision, document-review workflow/no-op/blocked outcomes and chat
  context. Only Wrangler is installed in its deployment directory; the 904-input build graph
  contains no frontend package. This is local artifact acceptance, not hosted
  deployment evidence. Refresh it again if executable source or migrations change.
- Transaction tests exercise stale multi-record reads, competing versions,
  late batch failure, receipt conflicts, declared indexes, schema writer fencing,
  lifecycle authority, and event publication/acknowledgement rollback/replay.
- The state-operator increment passed 25 focused state/API/Fetch tests, including
  atomic retry audit/export rollback, concurrency and authority revocation; the
  expanded backend-only Worker journey also passed. Client contract snapshots
  include public chat/state/message runtime schemas as well as declarations.
- The migration increment passed 38 focused SDK/state/client/compiler tests and
  all 17 D1 migration apply/upgrade/parity checks. The real Worker resumed a
  saved migration through the API, replayed its receipt, exported migrated state
  and recovered that state after quarantine. The v2 external-package fixture now
  compiles migration declarations with explicit capability requirements.
- Partial-repair coverage now includes 17 state tests: failed suffix recovery,
  completed-record preservation, exact receipt replay, changed-payload rejection,
  export/late-failure rollback, membership revocation, concurrent advance/repair,
  and the Fetch-to-handler contract with a registered-plan fixture. The complete
  unit suite passed 571 tests across 134 suites. All 18 D1 migrations passed apply,
  upgrade, parity and ledger verification; the backend-only Worker journey and
  external client consumer also passed. The Worker journey covers persisted
  migration advancement; a hosted registered-plan repair drill is still required.
- The execution-revision increment passed 585 tests across 135 suites and all
  19 D1 migration checks. Actual admission handlers exercise both transaction
  orderings: existing work blocks revision changes; a changed revision rejects
  stale work and rolls back intents, approvals and trace writes. Tests also cover
  immutable pins, stale resume, signed claim validation, canonical row selection,
  state continuity and pin preservation through payload retention. Typecheck,
  lint, documentation checks, the supervised production build and the standalone
  Worker journey passed. The build peaked at five processes and 1,234 MiB RSS.
- The pending-command increment passed 593 tests across 136 suites and all
  20 D1 migration checks, typecheck, lint, client contract/consumer checks and
  backend-only conformance. The standalone journey was rerun successfully against
  `bundle-67UP59`. The dependency security gate also passed with the existing
  two locally remediated advisory exceptions; this is not a complete secret scan.

- The explicit-upgrade increment passed 604 tests across 137 suites and all 21
  migration checks. Eleven focused tests cover exact snapshot history, state
  continuity across both targets, other-member state compatibility, concurrent
  commands/writes, revoked authority, export fencing, active dispatches, atomic
  late-failure rollback, Fetch contracts and the lifecycle D1 purge phase.
  The source Worker and standalone `bundle-armd75` journeys pass upgrade/history/
  replay and snapshot preservation through quarantine/recovery. Typecheck, lint,
  client contract and external consumer checks, documentation checks and the
  supervised production build passed (five processes, 1,401 MiB peak RSS).
  This does not prove complete Durable Object purge or large-scale upgrade latency.

- The context increment passed 622 tests across 139 suites, typecheck, lint,
  documentation checks and all 22 migration checks. Eighteen focused SDK/Worker
  context tests cover resolver bounds, deadlines, immutable evidence, replay,
  required-source blocks, no-op decisions, direct Admin dispatch, cancellation,
  kill switches, export locks, cross-target commit rejection and the lifecycle
  D1 purge phase. Source and standalone Worker journeys cover workflow/chat
  evidence, quarantine denial and recovery. V1/v2 SDK fixtures, the separately
  packed document-review package and the client consumer pass; contract snapshots
  are current. The supervised production build also passed (five processes,
  1,201 MiB peak RSS). This acceptance predates the model/budget increment below;
  no hosted context acceptance is claimed.

## Model/budget local acceptance

`pnpm verify:fast` passes for this increment: 640 tests across 140 suites, typecheck,
lint, documentation/architecture checks, all 23 migration checks and local
backup/restore. SDK v1/v2/document-review tarball consumers, the external client
consumer and both reviewed public contract snapshots pass. Eighteen focused usage
tests cover concurrent membership-wide reservations, canonical parent-run limits,
known/unknown usage, cancellation/revocation, configuration/settlement rollback,
immutable replay, stale/missing evidence, effective model configuration changes,
metadata pagination/redaction and the lifecycle D1 purge phase.

The extended source Worker journey and fresh standalone `bundle-qOhndT` journey
pass model-fixture summaries, quota exhaustion for chat/workflows, no-op execution
at zero quota, usage inspection and budget/receipt preservation through quarantine
and recovery. The 910-input standalone graph contains no frontend packages; only
Wrangler is installed in its deployment directory. No provider call was made.
The supervised production build also passes (five processes, 1,282 MiB peak RSS).
Keep both model and usage feature flags disabled in hosted environments.

The dependency security gate passes with its two existing locally remediated or
constrained advisory exceptions. A limited six-pattern scan covers 1,059 source,
standalone-artifact and SDK/client/example archive files without matches. Six
binary screenshots were excluded; history and hosted logs were not scanned.
This does not establish complete secret sanitization or production readiness.

## Durable-store local verification

The durable-store increment passes 653 tests across 141 suites, including 13
focused transaction tests. Coverage includes racing submissions/step claims,
configuration/handler mismatch, cancellation and deletion races, stale leases,
bounded retry, immutable replay, kill switches, active-upgrade fencing and the
lifecycle D1 purge phase. All 24 migration and local backup/restore checks pass.
These are persistence tests, not Cloudflare Workflow interruption acceptance.
Typecheck, lint, documentation checks and the supervised production build pass
(five processes, 1,265 MiB peak RSS). Fresh standalone `bundle-qGC2cP` passes the
existing backend-only journey with migration 0024 and the additional lifecycle
collections. This is regression acceptance for the current API; it does not
exercise a durable engine, because none is connected yet.

## Durable-port authority verification

State/context publication and model/tool reservation admission now validate the
active durable attempt in their D1 transactions. Missing or expired authority,
changed pins and superseded attempts fail closed. State receipt replay and model
output reuse require a live replacement attempt; per-step resource identities
preserve logical operation identity across retries. Existing v1 identities remain
unchanged. Already-incurred usage can settle after expiry without returning new
execution authority. The 22 focused durable tests include transaction expiry races,
atomic state/evidence/outbox rollback, context publication fencing, late model/tool
results and safe receipt reuse. The full suite passes 662 tests across 141 suites;
typecheck, lint, documentation checks and the supervised build pass (five
processes, 1,220 MiB peak RSS). Fresh standalone `bundle-jVp13h` passes the
backend-only journey with 911 audited build inputs and no frontend packages.
These are local port/admission and API regression checks; engine integration and
actual interruption/resumption acceptance remain pending.

## Native Workflows local verification

The actual local Workflows engine now executes opt-in v2 document review through
observation, a persisted wait and a canonical state/decision commit. Stable `202`
submissions reject changed content. Native step results contain only opaque D1
references; cached reference reads revalidate the step definition and current
authority. Terminal projection is atomic, replayable and rejects changed outcomes.
Compiler checks reject invalid bounds and v1 durable declarations. SDK 1.1.0's
reviewed contract includes the optional durable types; external v1/v2/document-review
package consumers pass. Native Worker types are scoped to their module so they do
not replace frontend DOM declarations.

The strict `pnpm conformance:runtime --durable-restart` drill **failed** after
restarting Wrangler during a persisted wait. Both D1 and engine receipts survived;
the installed Miniflare 4.20260603.0 alarm scheduler does not restart the execution.
`--durable-restart --local-engine-wake` passes with an explicit local wake event:
three completed steps retain one attempt each and the final state retains version
one. This is wake-assisted replay evidence, not automatic restart acceptance.
No production workaround was introduced; the automatic/hosted restart gate remains
open. See [durable execution](durable-execution.md) for the diagnostic and commands.

Current verification passes **668 tests across 141 suites**, including 27 durable
store/port tests, plus typecheck, lint, documentation and environment-template checks.
SDK contract and compiler-generated registries are current. Fresh standalone
`bundle-sjFZhk` (915 inputs, no frontend packages) passes the complete backend-only
journey with explicit-wake restart replay and cancellation during a native wait.
The supervised production build passes (six processes, 1,602 MiB peak RSS).
Environment-template validation does not resolve target resource references or
establish hosted credentials; no deployment or provider call was made.

## Durable recovery local acceptance

A leased reconciler now rotates up to sixteen due rows with four concurrent
inspections, bounded engine calls and persisted backoff. It recovers pending
startup, closes expired/revoked runs and confirmed engine failures/projection gaps,
and retries physical termination after canonical cancellation. It never restarts
or recreates a started instance. Closure, uncertain attempt receipts and events
commit atomically; successful prior results remain unchanged. Export fences defer
recovery and raw provider error content is never persisted.

The unit suite passes **680 tests across 141 suites**, including 39 durable-store/
recovery tests. New cases cover concurrent sweeps, lease replacement, database
revocation races, cancellation races, unknown outcomes, late-event rollback,
backlog rotation, export fences and disabled-feature deadline cleanup. Typecheck
and lint pass. All **25 migrations** pass fresh application, adoption, upgrade,
parity and local backup/restore verification. The real backend-only journey now
invokes the scheduler and independently reads the native instance to verify
termination after cancellation. Standalone `bundle-KnQOZ5` (917 inputs; Wrangler
as its only installed direct dependency) passes the complete journey, including
wake-assisted replay, with the artifact unchanged. The harness now checks for
artifact-local Wrangler and dispatches scheduler events through Miniflare's native
handler endpoint: Wrangler's `/__scheduled` middleware is absent in no-bundle mode.
The supervised production build passes (five processes, 1,174 MiB peak RSS).
Documentation and whitespace checks pass. This does not resolve the automatic
restart limitation or provide hosted interruption, engine deletion or trigger
acceptance.

## Durable context capture acceptance

Each logical durable step now captures immutable evidence with a server-selected
capture identity and atomically assigned revision. New steps resolve fresh
context after waits; retries retain their original snapshot and block stale
required evidence. The shared API/Fetch client pages scoped capture metadata and
loads full evidence by ID. Document review compares refreshed content with its
saved observation before committing, and links both snapshots to its decision.

Migration 0026 preserves historical IDs, hashes and JSON byte-for-byte while
replacing run-only uniqueness with capture/revision uniqueness. All 26 migrations
pass application, adoption, upgrade, parity and local restore checks. The focused
context/durable suite passes 58 tests, covering expired-retry retention, new-step
refresh, concurrent revision assignment, paginated scope isolation, late-event
rollback, changed-content rejection and historical migration preservation.
The real source Worker journey passes pagination and decision/evidence linkage,
including preservation through quarantine/recovery. The full suite passes **686
tests across 141 suites**, typecheck, lint, documentation and generated-registry
checks. The architecture gate now inspects the resulting SQLite schema and verifies
that export fences survive table rebuilds, instead of treating temporary migration
tables as retained application tables. SDK v1/v2/document-review and client tarball
consumers pass, including the capture-list method; reviewed public contract
snapshots pass. These additive SDK/client versions remain unpublished.

Fresh standalone `bundle-bVo79W` (917 inputs, no frontend packages; artifact-local
Wrangler only) passes the same context history and decision linkage journey plus
wake-assisted replay and native cancellation. All three logical steps retain one
attempt and three distinct context revisions after restart. The supervised
production build passes (five processes, 1,503 MiB peak RSS). Automatic local alarm
recovery and hosted readiness remain unproven; no deployment was performed.

## Native engine deletion local acceptance

Workspace purge now removes native Workflow instances in pages of 25 before
deleting their canonical identities. D1 records each confirmed deletion, preserves
partial progress and fences final cleanup with the current lifecycle-job lease.
Successful pages yield without consuming automatic failure retries. Native error
payloads are discarded; only exact not-found results establish idempotent absence.

Migration 0027 adds scoped creation-dispatch receipts, a lifecycle protocol marker
and engine deletion confirmations. An in-flight or ambiguous creation blocks purge.
Historical executions and old-worker admissions during rolling deployment retain
an uncertainty fence. Acknowledged instances are never recreated. New run IDs are
opaque; scoped submission receipts preserve retry identity and historical IDs,
while a recreated workspace cannot reuse an old native deletion target.

The focused durable suite passes **61 tests**; the full suite passes **703 tests
across 141 suites**. Coverage includes creation/quarantine races, duplicate startup,
historical and rolling-upgrade fencing, partial deletion, response loss, tenant
isolation, bounded paging, export fences and atomic rollback after job-lease loss
or final D1 failure. All **27 migrations** pass application/adoption/upgrade/parity
and local backup/restore checks. The restore verifier now identifies the database
by application tables: newer Miniflare also creates a metadata SQLite database,
so selecting the first filename was incorrect. Typecheck, lint, docs and whitespace
checks pass. The supervised production build passes (six processes, 1,855 MiB peak RSS).

The source backend-only journey independently lists native instances before and
after purge, injects failures after native deletion, verifies retained confirmation
records and completes D1 cleanup through owner retry. Unknown-dispatch operator
reconciliation and hosted deletion drills remain required; ordinary purge retry
cannot clear uncertainty. This increment does not establish hosted readiness.

Fresh standalone `bundle-UUelxj` (918 inputs, no frontend packages; artifact-local
Wrangler 4.135.0) passes the same native deletion and failed-cleanup retry journey,
plus wake-assisted replay with one attempt per completed step and physical engine
cancellation. The artifact remains unchanged during acceptance. Automatic local
restart is still unproven; the strict drill failed before this increment and no
alarm-recovery workaround was added. No hosted deployment was performed.

## Durable approval local acceptance

V2 workflows now pause for immutable named reviews with expiry, canonical
decision/consumption and leased native wake delivery. The review is not tool or
external-action authority. The document-review example links the receipt to its
decision and checks refreshed evidence and state versions after approval.
Shared client descriptors expose review payload, hash and expiry to both web
approval views and independent clients. Migration 0028 includes the records in
export, quarantine/recovery and purge.

The initial native journey failed before creating a review because its one-
millisecond sleep deadline elapsed during D1 work. The adapter now checkpoints
the remaining duration and uses a stable relative native sleep during replay.
The next run exposed D1's trigger-inclusive affected-row count: approval committed
but was reported as a conflict. Approval and recovery reporting now treat a
positive count as success under their single-row predicates. The SQLite test
adapter models D1's trigger counts so this regression is covered.

The full suite passes **715 tests across 141 suites**, including **72 durable
tests** and three human-intervention presentation tests. All **28 migrations**
pass application, adoption, upgrade, schema parity and local backup/restore.
Typecheck passes after rebuilding the shared client.

The ordinary source Worker journey passes native approval/denial, consumption,
decision linkage and full lifecycle cleanup. Fresh standalone `bundle-DiXeXj`
(920 inputs, no frontend packages; artifact-local Wrangler 4.135.0) passes the
same journey, descriptor parity between approval lists and history, and a process
restart while waiting for approval. The normal approval event wakes that run;
no test-only wake is sent to the approval instance. The separate timer restart
uses the explicit local test wake and retains one attempt per completed step.
The artifact remains unchanged during acceptance. A preceding source restart
attempt failed to complete its timer; only the frozen artifact result establishes
this increment's wake-assisted restart acceptance. Automatic local alarm recovery
and all hosted approval/restart acceptance remain open.

The shared SDK/client tarball consumers and generated registry checks pass;
reviewed public contract snapshots are updated without publishing either package.
The browser accessibility journey passes the Admin review dialog and History
review details on desktop and a 375px viewport, including literal rendering of
HTML-like review content. Its review payload is a presentation fixture; the real
decision path is verified by the independent native journey above. A pending
badge contrast failure found by Axe was corrected. The browser run used an
isolated runner port because an existing local service occupied the default.
Extension-contract conformance passes all 11 executable evidence rows. Typecheck,
lint, documentation and whitespace checks pass. The supervised production build
passes with five processes and 1,712 MiB peak RSS. No deployment or package
publication was performed; the eight-milestone plan remains incomplete.

## Durable trigger local acceptance

Declared triggers now opt into v2 durable execution through the shared API. D1
atomically transfers a current dispatch lease into one run and pins trigger
configuration. Pause or material configuration changes revoke active runs;
resumed work also rechecks membership and linked dispatch authority. Delivery
retries retain the dispatch's logical event identity. Pending schedule/monitor
observations coalesce without recounting duplicate or older ticks, and durable
manual/webhook ingress is bounded to 100 pending events per trigger.

The first native lifecycle journey exposed export pagination using `id` for the
new link table, whose primary key is `run_id`. The corrected collection passes
actual SQL export, foreign-workspace isolation and export-fenced admission tests.
The full suite passes **731 tests across 141 suites**, including **88 durable
tests**. All **29 migrations** pass application/adoption/upgrade/schema parity,
retained-data reapplication, ledger checks and local backup/restore.

Source backend-only conformance and fresh standalone `bundle-pkD4AZ` (921 inputs,
no frontend packages, artifact-local Wrangler 4.135.0) pass native scheduled
execution, authenticated webhook duplicate/conflicting payload handling, one run
per event, cancellation during approval, export, quarantine/recovery and native
engine/D1 purge. The frozen artifact also passes process restart during approval
with the normal decision wake. Timer replay uses the explicit local test wake
and retains one attempt per completed step; automatic local alarm recovery is
not established. No deployment or provider authentication was performed.

SDK v1/v2/document-review tarball consumers, the standalone client consumer,
reviewed SDK/client contract snapshots, generated registries and all 11 extension
contract evidence rows pass. The optional trigger `execution` field preserves the
existing request default. SDK/client versions remain unpublished. Typecheck,
lint, documentation and whitespace checks pass. The supervised production build
passes with five processes and 1,477 MiB peak RSS. Hosted backlog, restart and
handler-retention acceptance remain open.

## Durable deployment gate local acceptance

Guarded Worker deployment now builds a frontend-free candidate and runs its
compatibility probe against active D1 package/workflow/runtime/definition pins.
Migration 0030 supplies a non-expiring platform admission fence. The database
blocks new submissions across inspection and activation, including admissions
from old Worker code. Successful verification atomically records the new
deployment generation and removes the fence; stale Workers cannot admit new
work afterward. Existing runs and exact submission receipts remain usable.

Preflight incompatibility releases only its own fence without uploading. Upload
or verification ambiguity retains the fence and original artifact for explicit
resume or verified release. Activation acknowledgement loss is idempotently
reconciled against the recorded generation. The standalone artifact ships the
same dependency-free Node deployment helper; its Worker probe is authenticated
and available only in a loopback local environment. Target release evidence,
resource configuration and remote backup requirements remain in force.

The full suite passes **737 tests across 141 suites**, including **94 durable
tests**. Coverage includes overlapping deployments, lease-free persistence,
atomic activation rollback, stale Worker rejection, replay continuity,
incompatible handlers, disabled capabilities, probe isolation and uncertain
upload/verification recovery. All **30 migrations** pass application, adoption,
upgrade, schema parity, reapplication, ledger checks and local backup/restore.
The source native journey also checks real persisted handler hashes, a denied
HTTP submission during deployment, and stale Worker rejection after activation.
Typecheck, lint, docs and whitespace checks pass.

Final standalone `bundle-FCpycN` (922 inputs, no frontend packages, artifact-local
Wrangler 4.135.0) passes the same native gate and complete lifecycle journey.
Its packaged deployment CLI rejects the original capability-disabled candidate
against a live approval-waiting execution and releases the preflight fence.
Approval resumes after process restart using its normal event; timer replay still
uses the explicit local wake and retains one attempt per completed step. The
supervised production build passes with five processes and 1,211 MiB peak RSS.
Bootstrap now refuses an already-installed durable schema so that route cannot
bypass the final deployment guard.

Hosted activation, cross-region rollout and recovery still require same-commit
evidence. Function serialization supplements the package author's explicit
version contract; it cannot infer semantic compatibility of imported helpers.
No deployment or provider authentication was performed. The full runtime plan
and final sanitization remain incomplete.

## Simulation action local acceptance

Runtime Module v2 action bindings now require an explicit simulation/external
target. V1 omissions retain external semantics. The experimental `actions.simulate`
port uses a server-selected simulation scope and commits exact-version state,
decisions, effect evidence, delivery intent and receipt atomically. The transaction
rechecks membership role, tool permission, tool kill switches, current evidence and
durable attempt authority. External proposal and dispatch reject simulation bindings.
The feature remains disabled by default and does not advertise a new negotiated
production capability. See [simulation contracts](runtime-simulation.md).

Document review supplies request and durable simulation workflows. The durable
workflow first persists the proposal, then commits it against refreshed matching
evidence. A lost step acknowledgement can replay the original receipt without
recomputing state versions. Context binding now preserves the simulation port.
Native testing exposed D1's expression-depth limit in the combined authority
predicate; nested CASE branches retain the same CHECK-backed transaction while
remaining within the native limit. No new table or migration is needed.

The complete unit suite passes **750 tests across 141 suites**, including **106
durable tests**. Added coverage includes exact receipt replay after acknowledgement
loss, changed-content rejection, concurrent version conflict, atomic rollback on
role/permission/tool-kill/evidence/attempt changes, explicit target validation,
captured runtime identity, disabled capabilities and external dispatch rejection.
V1, v2 and document-review external-package consumers pass. The reviewed SDK
1.1.0 contract snapshot and unchanged client contract pass; packages remain unpublished.

Source backend-only conformance and frozen standalone `bundle-4fOEy4` (925 inputs,
no frontend dependencies, artifact-local Wrangler 4.135.0) pass request and native
durable simulation, duplicate submission and external-state isolation. The final
standalone journey inspects actual exported ZIP records for effects and receipts,
denies simulation reads during quarantine, verifies unchanged recovered evidence,
and proves records/entries/receipts/outbox are removed during workspace purge.
It also passes the existing approval, trigger and guarded-deployment journeys.
The packed zero-context Vite client consumer, typecheck, lint, documentation and
whitespace checks pass. The supervised production build passes with five
processes and 1,586 MiB peak RSS.
No hosted action, authentication, deployment or production capability promotion
was performed. External operation handling and approval-bound simulation remain open.

## Current deployment preparation

The tooling update to Wrangler 4.135.0 / Workers types 5.20260918.1 passes
typecheck, backend-only source conformance and the dependency security audit
(no unapproved high or critical advisories). The source journey includes native
steps/waits/cancellation, browser and Node clients, state/context, approvals,
export and quarantine/recovery. Documentation and whitespace checks pass.
The strict automatic restart drill still fails on its bundled
Miniflare 5.20260918.0-alpha: the persisted timer does not resume the run after
process restart. The emulator's alarm handler still only peeks at its queue.
This is an unresolved local acceptance limitation, not hosted failure evidence.
The existing agents/partyserver and Sentry dependencies also declare v4 Worker
type peers; typecheck passes, but the peer ranges have not been reconciled.

The checkout remains uncommitted, so the guarded hosted deployment command's
clean-worktree requirement is not met. The acceptance environment check also
fails in the current shell because its eight target resource/origin references
are unset; production fails the same resolved-configuration check with eight
unset references. Neither target has secret-configuration evidence for current
HEAD. This does not establish that hosted resources or credentials are absent;
target configuration must be loaded and verified before deployment.

A fresh resolved-configuration check also fails for the maintained `demo`
target: eight resource/application references are unset in the current shell.
Acceptance and production still fail with eight unset references each.

Deployment requires same-commit secret-configuration evidence, and remote
migration requires matching backup evidence. Local secret files and generated
output are ignored, but final source/artifact sanitization remains to be completed.
A repeated limited scan of 874 tracked and nonignored text files found no matches for selected
private-key, GitHub, AWS and model-provider token patterns. `git diff --check`
also passes. This is not a complete secret-history or deployment-artifact audit.

## Bound external-action reviews: local acceptance

Migration 0031 binds approvals to immutable proposal, runtime, agent, policy,
credential and declared state-version evidence, with at most fifteen minutes of
validity. CHECK-backed transactions revalidate authority at approval and dispatch.
Concurrent requests cannot create orphan approval/run records; changed-content
and cross-agent proposal replays fail closed. Historical unbound approvals must
be cancelled or denied and recreated. Terminal payload pruning retains review
hashes and identities, while pending, executing and unknown outcomes retain
their evidence. Reviews participate in canonical export and deletion.

Thrown dispatch errors, unrecognized statuses and invalid success payloads now
produce `outcome_unknown`, without persisting raw exception messages. Explicit
adapter-reported failures remain separate. Unknown outcomes cannot be dispatched
again through the execution command. This does not yet implement the isolated
provider-operation registry, reservations or projection repair.

Verification on the current uncommitted source:

- **771 tests / 142 suites pass**, including 21 bound-review tests with actual
  SQLite transactions. SDK v1, v2 and document-review external consumers pass;
  the reviewed additive SDK contract matches 19 normalized public files.
- All **31 migrations** pass empty apply, adoption, trigger upgrade, schema
  parity and retained-data reapply. Local backup/restore passes with checksum
  `48d1c264506b16e75cdcff2838933a6ecbe870cadb37963f4b84691393e408f3`.
- Native Cloudflare/signed-runner action acceptance passes in 32.7 seconds,
  including review hash/expiry exposure, approval, denial, timeout and
  reconciliation. This uses local fixture authentication and a synthetic provider.
- Source and frozen **`bundle-35ifJ1`** pass backend-only conformance, including
  native durable steps/waits, approvals, trigger deduplication, guarded deployment,
  simulation, export, quarantine/recovery and engine deletion. Its graph has
  **927 inputs and no frontend packages**; Wrangler is installed within the
  artifact directory. Bundle SHA-256:
  `fd5e69d7ab6460f29a4a5551335771f41bc8d4a452010927b9e90527ec2627bc`.
- Typecheck, lint, docs and whitespace checks pass. The supervised production
  build passes with five processes and 1,471 MiB peak RSS. Dependency audit has
  no unapproved high/critical advisories; two locally remediated exceptions remain.

Generated verification logs and browser scratch files are ignored and preserved
locally. A scan compared thirteen configured secret values and selected private-key,
GitHub, model-provider, AWS and Slack patterns across **901 working-tree files,
4,219 reachable historical blobs and 72 deployment-artifact files**. Source/history
findings were limited to the existing public local LangGraph test token also used
in local configuration; no artifact matches were found. This is not exhaustive
secret detection: ignored logs, remote logs, unreachable Git objects and artifact
dependencies were excluded. The local fixture token is too short to pass the
hosted secret validator and must not be used as a hosted credential.

Acceptance and production still each have eight unresolved environment
references in the current shell. The checkout remains uncommitted; same-commit
hosted secret and backup evidence is absent. No deployment, real provider login,
hosted external action or production capability promotion was performed.

## Credential-isolated provider operations: experimental implementation

Runtime Module v2 inline external actions can now name a platform-reviewed
`providerOperation` instead of package execution/reconciliation callbacks. The
broker owns fixed destinations, bearer/HMAC authentication, request identity,
bounded response parsing and allowlisted output. Approval binds the operation
version and configured destination. `WORKBENCH_PROVIDER_OPERATIONS_ENABLED`
defaults to false; no production capability promotion is claimed.

Migration 0032 separates dispatch receipts from action projection. A successful
provider response is recorded before publishing the action result. Lost responses
retain uncertainty; registered GET reconciliation cannot resubmit the mutation.
Terminal receipts repair failed action/run projections without another provider
request. Current membership and connection authority are checked; the final
dispatch transaction rechecks every kill switch and pinned credential/state
evidence. Resolved payloads follow retention, exports omit credential references,
and workspace purge includes receipts. Resource lifecycle remains distinct from
dispatch acceptance.

Local evidence:

- **792 tests / 143 suites pass**, including 20 provider-operation tests using
  actual SQLite transactions and a mocked Fetch boundary, plus a compiler test
  rejecting v1, callback and transport authority combinations. Final focused
  provider/review checks also pass after bounded-response cleanup.
- SDK v1, v2 and document-review archive consumers pass. The v2 fixture now
  declares a named non-financial operation through the package-only compiler;
  published declarations typecheck that binding. The additive SDK contract is
  reviewed and verified.
- All **32 migrations** and local backup/restore pass. Restore checksum:
  `062ba3f528a3986d3e6b305293b4d6cb326585ffb073f9ab152345c85daf0af0`.
- Typecheck, lint and documentation checks pass. Source backend-only conformance
  passes its existing chat/state/simulation/durable/approval/lifecycle journeys
  with provider operations disabled. This does not exercise the new broker over
  a real HTTP connection.
- The supervised production build passes with five processes and 1,321 MiB
  peak RSS. No native/Docker workloads ran concurrently with the build.

At this snapshot, native broker drills, receipt inspection and pre-admission
recovery were still open; the following increment supplies local evidence for
them. Still required: disposable hosted provider drills, domain resource
reservations and state projection, and ongoing observation of accepted pending
resources. The web inspection increment is recorded below.
Credential-version changes conservatively block remote reconciliation. The prior
frozen artifact and sanitization evidence predate this increment and must be
refreshed for a release. No deployment or provider authentication was performed.

## Provider recovery and native client acceptance

No-dispatch recovery now atomically proves receipt absence and fences the proposal
version before recording `not_dispatched`. Concurrent dispatch wins by creating a
receipt first, or loses authority after the recovery fence. The operation cannot
both dispatch and report no dispatch. The failed run and terminal reconciliation
remain visible after payload retention. Twenty-two provider tests cover these
orderings, admission revocation, receipt replay and projection repair.

The registered conformance-only capacity package supplies bearer and HMAC action
bindings through the normal package compiler and external SDK archive path. Its
native Worker journey uses an independently verifying HTTP service, without
registry/Fetch mocks, Next.js or model calls. It passes concurrent approval,
lost-response GET reconciliation, projection repair without provider requests,
redacted inspection/export, quarantine/recovery and populated receipt deletion.
Exactly four provider fixture effects and one reconciliation GET are observed.

Client 0.2.0 exposes typed `admin.actions`, `admin.requestAction` and
`admin.reconcileAction`. Shared schemas validate action receipts in both clients
and generate public OpenAPI, including approval/reconciliation `202` responses.
The public list query rejects invalid bounds. Nullable terminal/reference fields
are supported. Action-list cursor pagination and general administrative schema
coverage remain incomplete.

Current verification: **797 tests / 143 suites pass**; typecheck, lint and docs
checks pass. The native provider journey passes using these validated client
methods. The packed Node/Vite client consumer and reviewed 24-file declaration
contract pass. SDK v1, v2, document-review and provider-operation consumers passed
in the preceding fixture increment; no SDK implementation changed since that run.
Hosted flags remain disabled. This is not hosted provider or production evidence.

The bundled History view now exposes recent action evidence, including resolved
actions, proposal/result payloads, review hash/expiry, dispatch status, external
resource lifecycle, observation time and ledger. It offers reconciliation for a
provider result awaiting action projection, and shows explicit no-dispatch
outcomes. Evidence payloads render only when expanded. Cached actions survive a
failed refresh. Reconciled status no longer displays a running spinner.

Two supervised browser tests pass at 1440px and 390px, covering inspection,
reconciliation-only command routing, resolved evidence, failed-refresh retention
and horizontal overflow. Mobile uses the existing `/history` command. These tests
use controlled action API responses; the separate native provider journey proves
the actual broker/API lifecycle. Desktop/mobile screenshots were inspected.
The existing local runner on port 3101 was preserved by using an alternate port.

The final supervised build passes (five processes, 1,407 MiB peak RSS). Frozen
`bundle-V8QAhX` passes the complete backend-only conformance journey with
artifact-local Wrangler: chat/reconnect, state/simulation, context/model budgets,
package upgrades, native durable waits/approvals/triggers, guarded deployment and
workspace lifecycle deletion. It contains **935 build inputs and no frontend
packages**, with SHA-256
`500c0f82462cd7d1c5ae2d9ae6b1e329e810759a656e653e11ae83ecb72ccfa7`.
Provider-operation acceptance above uses the source Worker; the general frozen
artifact journey keeps that feature disabled.

The dependency audit passes with its two existing locally remediated exceptions.
A limited scan compares twelve configured credential values and selected token/
private-key patterns across **912 source files and 46 artifact files**, excluding
33 binary files. Source matches are existing public local smoke-test credential
defaults. The sole artifact pattern match is a PEM-header validation string in
`jose@5.10.0`, not a complete private key; no configured credential matches the
artifact. This pass excludes ignored/hosted logs, dependency files and Git history,
and does not establish exhaustive sanitization. No deployment or login occurred.

## Remaining acceptance gates

| Milestone                   | Still required                                                                                                                                                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2. Independent backend      | Complete shared API schemas, command-wide idempotency, hosted WorkOS acceptance and hosted deployment/operational acceptance.                                                                                                                                                    |
| 3. Portable chat/events     | Full artifact/tool presentation and administration contracts, live SSE interruption/replay drills, retained-receipt pruning/restart drill, real token-refresh acceptance.                                                                                                        |
| 4. Typed state              | Resumable validation for large upgrades, durable handler retention and complete deletion drills. Bounded migrations/index rebuild, reviewed partial repair and operator APIs are locally verified.                                                                               |
| 5. Context/decisions/models | Hosted context/model/budget acceptance and measured provider/resource limits. Scoped evidence, structured calls, reservations and deterministic no-op have local acceptance.                                                                                                     |
| 6. Durable execution        | Hosted restart/deletion/approval and deployment-gate acceptance, hosted backlog measurements and unknown-dispatch reconciliation. Native steps/timer waits, trigger linkage/coalescing, local handler-retention gate, bounded deletion and 202 submission are locally exercised. |
| 7. Controlled effects       | Approval-bound simulation, hosted provider-operation acceptance, domain reservations/state projection and ongoing external-resource observation. Native provider HTTP, receipt inspection, reconciliation, projection repair and lifecycle acceptance pass locally.              |
| 8. Operator/adoption        | Generic views and headless controls, completed notification recovery, resource-allocation example, scaffolding and runbooks. Document-review has a locally verified deterministic slice.                                                                                         |

No new capability has same-commit hosted acceptance, real WorkOS login evidence,
24-hour soak, controlled external-action drill, hosted restore rehearsal or
measured production limits. Local backup/restore is not a hosted restore rehearsal.
Keep public API, typed-state, context, model, usage and package-upgrade flags disabled in hosted environments.
