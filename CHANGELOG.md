# Changelog

## Unreleased runtime foundations

- Add experimental SDK 1.1.0 declarative provider-operation bindings. The broker
  owns bearer/HMAC authentication, fixed destinations, bounded responses and
  allowlisted output. Migration 0032 records outcomes independently of action
  projection; read-only reconciliation and projection repair do not redispatch
  mutations. Native fixture acceptance passes; keep hosted provider operations
  disabled pending hosted acceptance.
- Atomically fence provider actions that never reached dispatch admission before
  recording `not_dispatched`. A competing dispatch receipt prevents false recovery;
  a paused old continuation cannot dispatch after recovery. Preserve reconciled
  status after payload retention.
- Add client 0.2.0 action inspection, approval-request and reconciliation methods,
  shared runtime response validation and generated OpenAPI. Action summaries expose
  redacted provider receipts independently of action projection; nullable terminal
  fields are accepted by both frontend and headless clients. A registered external
  conformance package exercises bearer/HMAC, response loss, projection repair and
  lifecycle operations through the native Worker without Next.js or model calls.
- Expose recent action evidence and provider projection repair in web History.
  Keep resolved/no-dispatch outcomes visible, distinguish resource lifecycle from
  dispatch status, expand payloads on demand and retain cached actions on refresh
  failure. Verify inspection and reconciliation at desktop and mobile widths.

- Bind external-action reviews to full proposal/runtime/policy/credential/state
  evidence with a maximum fifteen-minute approval lifetime. Migration 0031 adds
  immutable scoped reviews and atomic transition checks; expired pending work is
  cancelled without changing accepted effects. SDK 1.1.0 adds optional declared
  state preconditions and an earlier action deadline. Changed-content or
  cross-agent proposal replay now fails closed. Historical unbound approvals
  require cancellation/denial and a new proposal; completed evidence is retained.
- Treat thrown dispatch errors and invalid success results as `outcome_unknown`,
  requiring reconciliation. Do not persist raw adapter exception messages. Keep
  explicit provider failure outcomes distinct and clear completed dispatch timers.
- Add experimental SDK 1.1.0 simulation targets and `actions.simulate`: atomically
  commit isolated state, decisions, effect evidence and delivery receipts. Recheck
  tool policy in the transaction and reject simulation at external dispatch.
  Preserve v1 external semantics. Document review persists its proposal before
  the durable commit so acknowledgement loss can replay the original receipt.
- Gate Worker deployment against active durable handler pins in the frozen
  candidate. Migration 0030 fences new admissions across inspection/activation,
  including old Workers; retain uncertain upload fences for explicit recovery.
  Ship the same guarded deployment command inside frontend-free artifacts.
- Add opt-in durable schedule/monitor/webhook execution with atomic dispatch-to-run
  admission, pinned trigger authority, pause revocation and bounded ingress.
  Coalesce pending observations without recounting duplicate ticks. Migration 0029
  includes trigger links in workspace export and purge; export pagination uses run IDs.
- Add experimental v2 `flow.approval` checkpoints with immutable review payloads,
  expiry, canonical decision/consumption and retryable native wake delivery.
  Migration 0028 includes approval metadata in export and purge. Shared client
  review descriptors and web approval views expose the same bound content.
  Review approval does not authorize external effects. Fix elapsed native waits
  and D1 trigger-inclusive mutation counts in approval and recovery reporting.
- SDK 1.1.0 and client 0.2.0 additions remain unpublished; durable execution
  remains experimental and unadvertised pending the remaining acceptance gates.

- Fence native engine creation with scoped dispatch receipts and remove native
  instances in bounded batches before workspace D1 purge. Retain partial deletion
  confirmations across retries; unresolved creation outcomes block purge. Migration
  0027 preserves historical uncertainty. Update Wrangler for its native deletion API.
- Capture immutable context per logical durable step, refresh evidence after waits
  and retain original evidence across retries. Add scoped revision pagination to
  the public API/Fetch client; preserve historical IDs and JSON in migration 0026.
  Document review now links both observations and refreshed evidence, rejecting
  changed content before committing state. SDK/client additions remain unpublished.

- Add leased, bounded durable-engine reconciliation with backoff, deadline and
  authority closure, immutable unknown-attempt outcomes and physical cancellation.
  Keep started instances protected from automatic recreation. Forward migration
  0025 stores recovery metadata in the existing execution/lifecycle boundary.
  Verify native cancellation through the standalone artifact without rebundling;
  require artifact-local Wrangler so acceptance cannot silently use workspace tools.
- Add experimental v2 durable step/sleep authoring and a Cloudflare Workflows
  adapter with stable `202` submission identities, bounded pending-start recovery,
  fresh attempt-scoped ports and atomic terminal projection. Document review
  exercises observation, a persisted wait and a state commit. Keep the feature
  disabled by default; automatic local process-restart recovery fails in the
  installed emulator, while explicit-wake replay passes. Hosted acceptance,
  approval waits, deployment handler retention and engine deletion remain open.
- Add an internal durable-execution persistence kernel with atomic run/submission
  identity, pinned configuration, named step attempts, bounded explicit replay,
  immutable results and lifecycle storage. This does not enable durable package
  production execution. Fence state/context commits
  and model/tool admission with server-owned step attempts; retain incurred usage
  after expiry and preserve receipt identities across safe retries.
- Add experimental structured model calls to SDK 1.1.0 with schema validation,
  configured-model selection, stored results and safe replay. Reserve workspace/
  root-run model/tool capacity atomically before dispatch, including chat steps.
  Report provider usage, estimates and fixtures separately through shared budget/
  usage contracts in client 0.2.0. Include receipts and atomic settlement events
  in lifecycle storage. Demonstrate summaries and quota-independent no-op decisions
  in the document-review package; no hosted model/budget readiness is claimed.
- Add opt-in Runtime Module v2, capability negotiation and a v1 adapter to the
  unpublished `@operloom/agent-sdk` SDK 1.1.0; preserve existing package identities.
- Add an experimental, default-disabled Worker public API with WorkOS bearer
  verification, explicit command scope and a loopback-only development adapter.
  Add a standalone Worker bundle with frontend-dependency auditing and independent
  deployment configuration.
- Add a Fetch runtime client and chat transport in `@operloom/workbench-client`
  0.2.0, public content blocks, cursor
  reset responses, generated chat schemas and backend-only supervised conformance.
- Retain chat command receipts beyond transcript pruning; export/purge them with
  their thread. Explicitly delete message rows during lifecycle purge.
- Add experimental typed state: scoped reads/indexes, transactional commits,
  receipts, immutable entries and atomic event publication with export/deletion coverage.
- Add scoped state, decision/effect and delivery inspection to the public API and
  Fetch client; add authorized optimistic retries with atomic audit and stable event identity.
- Add reviewed v2 state migration declarations, durable bounded batches and index
  rebuilds, replay receipts, database writer fencing and scoped admin commands.
- Add authorized partial-migration repair with registered replacement plans,
  unchanged schemas/indexes, complete plan history and atomic idempotent receipts.
- Fence obsolete execution admissions and state handles with server-owned agent
  revisions, D1 admission/resume checks and signed chat claims. Preserve generation
  zero compatibility.
- Register pending HTTP chat commands before acknowledgement; atomically link them
  to one run, expose canonical outcomes through API/Fetch, and fence cancelled or
  expired execution. Include records in export, quarantine and purge.
- Add experimental explicit package upgrades and paginated snapshot history to the
  API/Fetch client, with state/index/trigger validation, atomic revision/receipt/audit
  commits and lifecycle coverage. Keep upgrades disabled by default.
- These additions do not establish durable workflow or hosted production readiness;
  see [delivery evidence](docs/runtime-delivery-status.md).
- Add experimental scoped context resolvers, bounded immutable evidence snapshots,
  required-context blocks and atomic evidence-expiry checks for typed commits.
  Expose snapshots through shared API/Fetch contracts and include them in lifecycle
  storage. Add a frontend-independent document-review package with deterministic
  observation, versioned state and recorded no-op decisions without provider usage.

## 1.0.0

- Update vulnerable image dependencies and harden archive extraction; see
  [dependency remediation](docs/dependency-security.md).

- Stabilize the web developer-workbench contract: chat, trusted agent packs,
  read-only workflows, artifacts, and history.
- Keep failed workflow inputs and recovery actions visible; preserve failed-run links.
- Treat empty, reasoning-only, and truncated model output as recoverable failures;
  disable automatic provider retries.
- Enforce workflow deadlines and recover abandoned manual runs through Durable
  Object alarms, independently of cron schedules.
- Document 1.x compatibility, clean setup, upgrade acceptance, and release gates.
- Keep hosted credential brokerage, mutations, and unattended automation
  experimental and disabled by default. Mobile remains WIP.

## Pre-1.0 development (formerly 0.5.1 candidate)

- Consolidate the personal hosted deployment under Operloom, with one runner
  that scales to zero, paused notification delivery, and archived legacy stacks.
- Restore signing of the existing identity-header namespace after the rebrand;
  reject modified tenant/role headers before persistence and runner execution.
- Add optional `networkPolicy` to the unpublished `@operloom/agent-sdk` SDK 1.0.1
  execution context. The gateway supplies signed restrictions and the URL runner
  enforces them on initial requests and redirects. Custom network tools must
  honor this context; trusted runner modules are not OS-isolated sandboxes.
- Use the explicit release SHA when CLI deployment metadata contains a blank
  Git SHA, and update the runner smoke to the versioned invocation contract.

- Bound development process groups and memory, clean up grandchildren on shutdown,
  and use Webpack for development to avoid runaway Turbopack loader workers.
- Make account-free local startup consistent across the auth proxy, provider,
  and identity resolver; reject the local mode in hosted environments. Restore
  the documented optional LangGraph model default and keep local tracing opt-in.
- Fix generated hyphenated agent identifiers and synchronous health/eval tests
  so the documented first-agent workflow passes its own developer gate.
- Add an accessible chat-rename dialog with inline failure recovery.
- Handle exact slash commands before the first thread is materialized, so navigation
  is never submitted as a chat turn; defer closed operator panels from server rendering.
- Update tar, browserslist, and fast-uri to patched versions.
- Rename the product and workspace packages to Operloom (`@operloom/*`); update
  imports together when upgrading. Existing signed transport headers remain
  stable; hosted resource migration is recorded in the minimal testing runbook.
- Preserve native clients on `codex/mobile-wip`; remove Expo from the web
  installation and native checks from the web release gate. Remove the former
  Expo security exceptions.
- Add the `pnpm operloom` CLI alias, web-only fork configuration, adoption guides,
  and an architecture-focused README.

Production-hardening release with a shared runtime-validated frontend client,
one React Query resource model, credential-safe observability across Vercel,
Cloudflare, and Fly, a decomposed connection broker, and executable hosted
configuration/observability drift gates. Production remains at retained data
plus connections; mutation, push, and conformance stay globally disabled.

- Mobile chat protocol v2 adds a framework-neutral resumable controller,
  durable queued-turn replay, formal terminal session events, and foreground
  recovery without treating transcript arrival as completion authority.
- Durable chat commands no longer wait for the disposable realtime observer;
  native and web clients can accept an idempotent turn while live updates
  reconnect, with bounded connection attempts and explicit delivery state.
- On the archived mobile WIP branch, native pack output is fully generic: declared JSON, Markdown, and table
  artifacts, managed state, workflow schemas, reasoning, and tool calls render
  without pack-specific mobile source code.
- The archived mobile WIP acceptance path requires same-commit iOS and Android evidence,
  while native Sentry uses the shared credential scrubber and build-only symbol
  upload authority.

## 0.5.0

Internal pre-1.0 foundation implementing the local Operational L3 and Authority A2 contracts.

- Forward-only customer-data migrations, confirmed per-workspace retention,
  checksummed D1/R2/Durable Object export, and 30-day deletion recovery/purge.
- Snapshot-consistent exports using a bounded D1 write fence, Durable Object
  freeze, keyset staging, R2 pins, and an auditable manifest v3 snapshot cut.
- Phase-checkpointed purge failure recovery with fresh-auth owner retry,
  compare-and-set fencing, redacted errors, and preserved deletion authority.
- WorkOS Vault credential custody with API-key and OAuth 2.0 + PKCE brokerage,
  scoped provider requests, refresh CAS, health, and revocation.
- Durable mutation proposals, approvals, policy rechecks, kill switches,
  idempotency, terminal action ledger, ambiguous outcomes, and reconciliation.
- Deterministic Complex Operator mutation evidence without financial actions or
  public provider traffic.
- New lifecycle, connection, mutation, hosted Vault, and hosted mutation gates.
- Stable unpublished `@operloom/agent-sdk` SDK 1.0.1 contract with correct
  SemVer prerelease precedence, explicit
  workbench-version compatibility and normalized declaration/schema hashes.
- Deterministic synthetic release screenshots and strict Node 24/package
  metadata validation.
- Domain-split workbench types, control-plane clients, session coordination,
  lifecycle, and action-authority modules behind import-compatible façades.
- Production feature promotion through retained data and connections. The
  mutation subsystem is compiled and conformance-proven but remains globally
  disabled outside isolated acceptance.
- Serious/critical Axe gating plus deterministic keyboard, focus-trap, and
  desktop/mobile overflow acceptance across the primary workbench surfaces.
- Public health identity agreement across Vercel, Cloudflare, and Fly using the
  same full release SHA and application version.
- Unpublished framework-neutral `@operloom/workbench-client` and React
  Query adapter packages, dogfooded by the web session, Agents, History,
  workflow, approval, and Connections surfaces with a hashed client contract.
- Default-off WorkOS mobile bearer identity with authoritative bearer handling,
  issuer/JWKS/client allowlisting, cookie-equivalent tenancy, and configured
  independent-frontend CORS.
- Versioned chat transport descriptors, durable `clientTurnId` deduplication,
  bounded session-event replay, cursor-reset snapshots, and shared resumable
  event streaming for web and native clients.
- Expo Router iOS/Android operator reference app with native navigation,
  SecureStore identity, SQLite display/draft state, generic pack workflows,
  History, approvals, connections, and action recovery.
- Provider-neutral, Vault-backed Expo push delivery for approvals and terminal
  outcomes through a redacted Cloudflare Queue ledger, default-off until real
  device acceptance.

The public 1.0 tag remains blocked until the same-commit hosted checklist in
`docs/release-readiness.md` is complete. Version 0.5 makes no production-SLO claim.

## 1.0.0-preview.1

Developer preview of the source-available Operloom agent workbench.

- Authenticated, tenant-scoped Cloudflare Agents chat and workbench controls.
- Code-first Agent Packs with bounded read-only workflows and policy-gated tools.
- Durable D1 run, approval, tool-call, audit, event, and artifact metadata.
- Signed Fly runner boundary for repository inspection and hardened public URL reads.
- Monotonic terminal runs, cancellation authority revocation, retry lineage, and History recovery.
- Deterministic unit, service-boundary, browser, build, documentation, and dependency gates.

Preview data contract: remote D1 records and metadata artifacts are disposable.
No forward-compatible migration, backup/restore, retention, external mutation,
encrypted credential custody, or artifact-blob guarantee is included.
