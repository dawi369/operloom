# Changelog

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
