# Plan 001: Make runtime freshness truthful and recoverable

> Executor: run the drift check first; preserve all pre-existing user edits. Complete each verification before proceeding. STOP rather than broadening scope. Update `advisor-plans/README.md` only after completion.

## Status

- Priority P1; effort S; risk MED; category bug/UX; depends on none.
- Planned at commit `2bb9ec0`, 2026-09-26.
- Drift check: `git diff --stat 2bb9ec0..HEAD -- components/workbench/workbench-runtime-hint.tsx lib/workbench/admin-summary-resource.ts lib/workbench/chat-runtime-live-state.ts lib/workbench/admin-summary-resource.test.ts tests/e2e/workbench-accessibility.spec.ts`

## Why

After sign-in, the runtime hint can say “synchronizing refreshed details” indefinitely even when no catch-up request is active. This is a trust bug: connection health and summary freshness are different facts. Show the actual state, make stale data recoverable, and retain usable cached content during a slow refresh.

## Current state and constraints

- `components/workbench/workbench-runtime-hint.tsx:61-69` initially calls `refreshSummary({ source: "initial" })` without a freshness watermark. At `:189-225`, `summaryIsStale` displays “synchronizing” for every status except `exhausted`, including `idle`.
- `lib/workbench/admin-summary-resource.ts` owns the `idle | catching_up | exhausted` status, a 900 ms cooldown, three catch-up attempts, and a ten-second window. `lib/workbench/chat-runtime-live-state.ts` compares `summary.generatedAt` with the latest session-event timestamp.
- `lib/workbench/admin-summary-resource.test.ts` covers coalescing and catch-up, but not the signed-in stale-summary + idle-status presentation. Existing `plans/001-live-runtime-convergence.md` is archived DONE; this is a narrower regression, not a request to repeat that migration.
- The worktree already contains unrelated uncommitted changes, including `tests/e2e/workbench-accessibility.spec.ts`. Preserve them. Cloudflare remains the authority; do not fake a fresh timestamp or use a browser timer to declare data current.

## Scope

In scope: the five drift-check paths above, plus a focused component test file if necessary. Out of scope: Cloudflare session protocol, auth, polling services, new dependencies, `components/assistant-ui/*`, provider resource identities, and any Polymancer logic. Read the installed Next guide under `node_modules/next/dist/docs/` before editing a Next component, per `AGENTS.md`.

## Steps and gates

1. Add a failing test for stale summary + `idle` status, connected event stream, and a later fresh summary. Assert that the UI never says “synchronizing” while no refresh is pending, that it offers a manual retry after exhausted/idle-stale, and that fresh data clears the stale notice. Model the resource tests after `lib/workbench/admin-summary-resource.test.ts`. **Verify:** `pnpm exec vitest run lib/workbench/admin-summary-resource.test.ts` must fail on the new regression assertion before the fix.
2. Reconcile the freshness/status contract at its existing ownership seam. Pass the latest event watermark when requesting catch-up where appropriate; make `idle`/stale a distinct truthful presentation or trigger a bounded catch-up. Keep the existing bounded retry/cooldown behavior and a visible Refresh action after exhaustion. Do not hide or replace cached shell content during refresh. **Verify:** the focused Vitest test exits 0.
3. Add one local-session browser regression to `tests/e2e/workbench-accessibility.spec.ts` only if its existing fixture can deterministically control summary and event order. If it cannot, keep the component/resource test and document the browser gap in the PR; do not create a flaky timing assertion. **Verify:** `pnpm test:e2e:local:release` exits 0 when a browser test was added; otherwise `pnpm verify:fast` exits 0.

## Done criteria

- `pnpm verify:fast` passes; `pnpm test:e2e:local:release` passes if changed.
- Stale, catching-up, exhausted, and fresh states have separate deterministic assertions; no state claims active synchronization when no refresh is pending.
- A stuck state can be retried without a page reload; no unbounded background traffic is introduced.
- Only in-scope files and the plan index differ from the executor's starting diff. Commit convention: `fix(workbench): ...`; do not push or open a PR without instruction.

## STOP conditions

- Current code/fixtures differ materially from the excerpts or overlap a pre-existing user edit that cannot be safely preserved.
- Fix requires changing Cloudflare message/session authority or a public client contract.
- Two focused repair attempts still fail, or the browser fixture would require timing-dependent sleeps.
