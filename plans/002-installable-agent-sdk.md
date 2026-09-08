# Plan 002: Publish a real installable Agent SDK contract

> **Executor instructions**: Build and test the packed artifact as an ordinary
> dependency. Passing through TypeScript `paths` into package source is not
> acceptance. Update `plans/README.md` when done.
>
> **Drift check**: `git diff --stat 5eb783a..HEAD -- packages/agent-sdk scripts/verify-agent-sdk-consumer.ts scripts/agent-pack-compiler.ts scripts/agent-pack-compiler.test.ts workbench.config.ts docs/agent-runtime-kit.md`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED - package exports affect all compiled packs
- **Depends on**: none
- **Category**: dx
- **Planned at**: `5eb783a`, 2026-08-01

## Why this matters

The Runtime Kit is convincing inside the monorepo, but the SDK tarball exports
raw `.ts` files and its consumer check maps imports directly into unpacked
source. The north-star promise requires a normal package install, runtime import,
type resolution, and compiler use without core source edits.

## Current state

- `packages/agent-sdk/package.json:6-33` publishes `src` and points all exports at
  `.ts` source.
- `scripts/verify-agent-sdk-consumer.ts:20-61` extracts the archive and uses
  TypeScript `paths` targeting `package/src/*`; it never installs the tarball or
  executes its JavaScript.
- `scripts/agent-pack-compiler.ts:259-309` already supports package subpath
  imports when `source` is absent.
- Every entry in `workbench.config.ts:5-22` currently sets `source`, so that path
  has no package-level conformance fixture.

## Scope

**In scope**:

- `packages/agent-sdk/**`
- `scripts/verify-agent-sdk-consumer.ts`
- `scripts/agent-pack-compiler.ts`
- `scripts/agent-pack-compiler.test.ts`
- a new `tests/fixtures/external-agent-package/**`
- package/build scripts and lockfile only if a build dependency is required
- `docs/agent-runtime-kit.md`, `docs/agent-packs.md`

**Out of scope**: remote package installation, untrusted executable uploads,
Runtime Module v2, Pack API v3, runtime sandboxing, or publishing to npm.

## Steps

1. Give the SDK a real build. Produce ESM JavaScript, source maps, and `.d.ts`
   files under `dist` for `.`, `manifest`, `control-plane`, `runner`, and `web`.
   Prefer one small package-build tool only if TypeScript cannot emit valid Node
   ESM without source churn. Point `exports`, `files`, and `types` at `dist`; add
   `build`, `clean`, and `prepack`. Keep JSON schemas in the archive and export
   stable schema subpaths if consumers need them.

   **Verify**: `pnpm --filter @operloom/agent-sdk pack --pack-destination output/sdk-consumer`
   produces a tarball containing `dist/*.js`, `dist/*.d.ts`, schemas, README, and
   no `src` dependency for execution.

2. Rewrite `agent-sdk:verify` to create an ignored clean consumer with its own
   `package.json`, install the tarball as a dependency, and use normal package
   resolution. Remove all `paths` mappings. Typecheck imports from every public
   subpath, then execute a `.mjs` file with Node 24 that calls harmless SDK
   helpers.

   **Verify**: temporarily rename the extracted source directory if retained;
   `pnpm agent-sdk:verify` must still pass.

3. Add an external-style fixture package that depends on the packed SDK and
   exports a minimal manifest/control-plane/runner/web module. Compile a temporary
   `workbench.config.ts` entry containing only `package`, with no `source` and no
   imports from repository internals.

   **Verify**: a focused compiler test generates all registries from the installed
   fixture and confirms the Worker registry does not import runner executables.

4. Add negative tests for missing subpath exports, invalid declaration files,
   incompatible runtime ranges, and packages that resolve only because of
   workspace hoisting. Diagnostics must name the package and missing export.

5. Update the SDK README and runtime docs with an install/build/compile golden
   path. State that the package is publish-ready but initially unpublished and
   trusted at build time.

## Done criteria

- `npm`/`pnpm` package consumers resolve only `dist`, never repository source.
- Node 24 can execute every runtime-bearing public subpath.
- TypeScript resolves declarations without `paths`, workspace links, or source
  inclusion.
- A no-`source` package compiles into deterministic registries.
- `pnpm agent-sdk:verify`, pack validation, agent-system conformance, typecheck,
  lint, build, and `git diff --check` pass.

## STOP conditions

- Stop if a public SDK subpath imports Cloudflare `Env`, D1 types, auth headers,
  credentials, or Node-only runner code across the control-plane boundary.
- Stop if making the package executable requires Runtime Module v2.
- Stop before npm publication; publication is a separate operator action.

## Maintenance notes

CI should inspect the tarball, not merely compile workspace sources. Any future
public subpath must be added to both runtime-import and type-resolution fixtures.
