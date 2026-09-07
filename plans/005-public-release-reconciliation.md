# Plan 005: Reconcile public metadata, documentation, screenshots, and runtime versions

> **Executor instructions**: Update claims only after Plans 001-004 are complete.
> Generate screenshots from deterministic non-customer fixtures and inspect them
> for secrets before tracking. Update `plans/README.md` when done.
>
> **Drift check**: `git diff --stat 5eb783a..HEAD -- README.md docs package.json agent-packs/baby-swordfish/package.json agent-packs/baby-swordfish/index.ts .github/workflows/verify.yml`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: Plans 001-004
- **Category**: docs
- **Planned at**: `5eb783a`, 2026-08-01

## Why this matters

The public surface currently contains screenshot placeholders, stale migration
counts, an inaccurate Swordfish workflow claim, mismatched package/manifest
versions, and an open-ended Node engine. These are small defects individually
but undermine a release whose central promise is executable conformance.

## Scope

**In scope**:

- `README.md`, relevant current-state docs, docs map, changelog/release checklist
- `docs/assets/release/**` and a deterministic screenshot capture script/test
- root and Swordfish package metadata
- CI/doctor checks for runtime and metadata consistency

**Out of scope**: product redesign, new Swordfish execution, a new documentation
site, npm publication, license changes, or changing Pack API/Runtime Module APIs.

## Steps

1. Pin the supported production runtime to Node `24.x`; keep pnpm major pinned.
   Make `workbench:doctor` fail on the wrong Node major. Ensure CI, Docker, and
   Vercel use the same major. Do not upgrade Node in this slice.

2. Align `@operloom/pack-baby-swordfish` package version with manifest
   `1.2.0`. Extend pack validation so every package/manifest version mismatch is
   a compile failure. Keep Swordfish tools/workflows/triggers empty and document
   historical chat-only compatibility.

3. Replace hard-coded migration prose with the current chain through Plans 003
   and 004. Extend docs/release checks so current migration filenames, latest
   migration, reset parity, and public counts cannot drift silently.

4. Correct README Agent Pack wording: Repository Analyst and Polymancer are live
   read-only workflows; Swordfish is packaged, chat-capable, parked, and has no
   executable runtime. Keep Complex Operator clearly conformance-only.

5. Add a deterministic screenshot command that starts the isolated local stack,
   seeds synthetic identities, and captures Workbench, History/recovery, Agent
   Packs/policy, Connections, retention/export, and action ledger states. Save
   stable, compressed images under `docs/assets/release/`. Assert no secret input,
   raw token, email outside the synthetic domain, local absolute path, or error
   overlay appears. Replace README placeholders with those images and alt text.

6. Reconcile README, architecture, capability, runtime kit, migrations,
   release-readiness, and changelog claims against executable commands. Mark
   hosted gates pending until Plan 006 evidence exists; do not declare 1.0 ready
   from local conformance alone.

## Done criteria

- Node major is deterministic across package metadata, CI, Docker, doctor, and
  deployment docs.
- Pack validation catches version mismatches; Swordfish metadata is consistent.
- No README screenshot placeholder remains and screenshots contain synthetic
  non-secret data only.
- Docs describe the actual migration ledger and lifecycle semantics.
- `pnpm docs:check`, pack compile/validate, doctor, unit tests, typecheck, lint,
  build, and `git diff --check` pass.

## STOP conditions

- Stop if screenshot capture requires a real customer identity or production
  credentials; use local deterministic state instead.
- Stop if a documentation claim lacks executable or hosted evidence; mark it
  pending rather than inferring completion.
- Stop if Node 24 is unsupported by any current deployment target and report the
  exact primary-source constraint.

## Maintenance notes

Treat screenshots and version claims as generated release artifacts. The release
check should detect placeholders, pack-version mismatches, and migration drift.
