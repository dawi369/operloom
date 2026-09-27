# Plan 002: Present runs and artifacts progressively

> Executor: run the drift check first; preserve all pre-existing user edits. Verify each step; STOP rather than expanding the product contract. Update `advisor-plans/README.md` only after completion.

## Status

- Priority P1; effort M; risk MED; category UX/architecture; depends on none, but land after plan 001 for coherent browser acceptance.
- Planned at commit `2bb9ec0`, 2026-09-26.
- Drift check: `git diff --stat 2bb9ec0..HEAD -- components/workbench/workbench-history-panel.tsx components/workbench/runtime-artifact-content.tsx lib/workbench/history-surface.ts lib/workbench/history-surface.test.ts agent-packs/repo-analyst/web.ts agent-packs/baby-polymancer/web.ts tests/e2e/release.spec.ts`

## Why

History already contains canonical run snapshots and artifact descriptors, but selecting a run replaces its detail with a spinner during every fetch, and generic history preview logic hard-codes report kinds from particular packs. Preserve instant selection and cached results, show the user what a run produced first, and keep domain interpretation in pack web contributions so Polymancer can grow without changing the base shell.

## Current state and constraints

- `components/workbench/workbench-history-panel.tsx` queries runs, artifacts, and actions when open, then fetches the selected run. Its main panel chooses `isLoadingRun` before `selectedRunSnapshot`, so background refetch can blank existing detail. The selected-run view already has status, summary, Results cards, and technical details; do not replace it.
- `lib/workbench/history-surface.ts:44-87` special-cases `repo_readiness_report`, `market_research_report`, and `runtime_research_report` to form preview lines. `components/workbench/runtime-artifact-content.tsx` already resolves trusted pack renderer contributions with a sanitized generic fallback and error boundary. Repo Analyst and baby-Polymancer web modules declare artifact renderer descriptors. Prefer that existing extension seam; do not invent an arbitrary browser-side renderer registry.
- `docs/agent-workbench.md` puts workbench composition outside reusable `components/assistant-ui/*`; `docs/architecture.md` keeps run/control state in Cloudflare and delegated heavy work on Fly. Tool policy currently declares `modelVisible: false` for the read-only repo tool. Do not turn this into model-visible tool calls or imply a workflow result is a chat message.
- Run/artifact detail remains demand-loaded; preloading metadata must not wake Fly or fetch large bodies. Existing `tests/e2e/release.spec.ts` has user edits: preserve or STOP if the same section conflicts.

## Scope

In scope: drift-check paths, optionally one focused test for `runtime-artifact-content`, and `lib/agent-runtime/web-registry.ts` only if its existing descriptor resolution needs a minimal typed helper. Out of scope: public SDK schema changes, provider APIs, assistant-ui low-level message renderer, new dependencies, new persistence, chat/workflow unification, and market-specific UI in core files. Read the installed Next guide before editing Next components.

## Steps and gates

1. Add tests in `lib/workbench/history-surface.test.ts` for a generic artifact, a missing renderer, and a malformed payload. Confirm pack-specific report content is not required for generic history. **Verify:** `pnpm exec vitest run lib/workbench/history-surface.test.ts` passes before UI changes; if a test intentionally exposes the hard-code, record its expected failure first.
2. Make the compact preview pack-neutral: extract a bounded top-level or `report.summary`, first warning, and safe URI when present, without branching on artifact kind. Keep full details in existing `RuntimeArtifactContent`, which already resolves trusted pack web contributions; do not invent a new preview extension field. **Verify:** `pnpm exec vitest run lib/workbench/history-surface.test.ts scripts/agent-pack-compiler.test.ts` exits 0, and `pnpm agent-packs:compile --check` exits 0.
3. In `WorkbenchHistoryPanel`, show cached selected-run detail during refetch with a small “Refreshing” indicator, and show a new loading state only when no detail for that selected run exists. Do not accidentally display the previous run's detail after selection changes; prove this with a focused test or deterministic local-session browser assertion. Keep status, results, errors, cancel/retry, and approval controls intact. **Verify:** `pnpm test:e2e:local:release` exits 0 with an assertion covering first open, cached refresh, and switching between two runs. If the fixture cannot produce two runs deterministically, STOP and report before weakening that gate.
4. Run the full fast gate and production build, sequentially, then inspect the changed-path diff for domain terms remaining in core preview logic. **Verify:** `pnpm verify:fast && pnpm build` both exit 0; `rg -n 'repo_readiness_report|market_research_report|runtime_research_report' lib/workbench/history-surface.ts` returns no matches.

## Done criteria

- Existing run and artifact affordances remain; cached detail is never blanked by a refetch or confused with another selected run.
- Generic history previews no longer branch on specific pack report kinds. Full artifact detail still uses trusted pack contributions with safe fallback for valid, unknown, and malformed artifacts.
- Browser test and fast/build gates pass. Only in-scope files and plan index differ from the executor's starting diff. Commit convention: `feat(workbench): ...`; no push or PR without instruction.

## STOP conditions

- Generic summary/warning extraction cannot safely represent the existing reports without altering a public SDK contract; propose that as a separate reviewed migration.
- Artifact data needed for preview is unavailable from current metadata-only API; do not introduce eager body fetching or R2 reads.
- A two-run browser fixture is not deterministic, a user edit overlaps the target block, or verification fails after two bounded attempts.
