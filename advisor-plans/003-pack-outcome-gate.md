# Plan 003: Add a bounded pack outcome gate

> Executor: run the drift check first; preserve all pre-existing user edits. Work only inside the existing deterministic pack-test path. Update `advisor-plans/README.md` when complete.

## Status

- Priority P2; effort M; risk LOW; category tests/DX; depends on none, recommended after plans 001-002.
- Planned at commit `2bb9ec0`, 2026-09-26.
- Drift check: `git diff --stat 2bb9ec0..HEAD -- agent-packs/repo-analyst/control-plane.ts agent-packs/repo-analyst/control-plane.test.ts docs/evals.md`

## Why

Pack conformance currently proves schemas, resource limits, and renderer presence, but a syntactically valid report can still be unhelpful or misleading. Before building a real Polymancer agent, make one deterministic, pack-owned outcome assertion reproducible in main. This is a reusable quality gate, not a generic LLM judge or hosted trace platform.

## Current state and constraints

- `scripts/test-agent-pack.ts` loads pack modules, executes control-plane evals, creates dry-run contexts, checks workflow output schemas/artifact limits/tool-call ceilings, and returns `{ ok, packId, results }`. The runner uses `scripts/agent-pack-test-fetch.ts` fixtures, so it must remain offline/provider-free.
- `agent-packs/repo-analyst/index.ts` declares `static_smoke` and `deterministic_runtime` evals and smoke scenarios, but the generic harness does not assert the usefulness of report contents. `docs/evals.md` explicitly excludes an LLM judge, new eval service, stored prompt corpus, and hosted schedule replay from v0.
- Pack-specific expectations belong in the pack, not in `scripts/test-agent-pack.ts` branches keyed on pack ID. The current `repo.plan.runtime` eval in `agent-packs/repo-analyst/control-plane.ts:255-258` returns unconditional success; it can exercise the pure `buildReadinessReport` function in that same module. Do not modify the published SDK/manifest schema in this plan.

## Scope

In scope: drift-check paths only. Out of scope: Polymancer domain prompts, generic harness changes, external model calls, LangSmith, production trace retention, new backend service, public SDK schema or hosted demo configuration.

## Steps and gates

1. Characterize a synthetic `RepoSnapshotOutput` using the local pure `buildReadinessReport` path and name stable invariants: bounded source inventory, explicit limitations including no deployed-health claim, and warning/status consistency. Add `agent-packs/repo-analyst/control-plane.test.ts` with a valid fixture and an intentionally misleading or empty report that must fail a validator. **Verify:** `pnpm exec vitest run agent-packs/repo-analyst/control-plane.test.ts` fails on the negative assertion before adding the validator.
2. Add the minimal local validator and replace the unconditional `repo.plan.runtime` eval success with deterministic report construction and those semantic checks. Return `{ ok: false, summary }` on validation failure; do not alter the generic test harness or public contracts. **Verify:** focused tests pass and `pnpm agent-packs:test --pack repo-analyst` exits 0 with `eval.repo.plan.runtime` in its results.
3. Update `docs/evals.md` with one concise distinction between contract conformance and semantic pack outcome checks, including the command and the no-hosted-tracing boundary. Do not add a broad eval roadmap or a dataset containing user messages. **Verify:** `pnpm docs:check && pnpm verify:fast` exits 0.

## Done criteria

- The fixture passes, an intentionally misleading/empty report fails, and no network/model credential is required.
- Assertion ownership is pack-specific; generic harness contains no Repo Analyst or Polymancer IDs.
- Existing contract/resource checks remain; fast gate passes. Only in-scope files and plan index differ from the executor's starting diff. Commit convention: `test(agent-packs): ...`; no push or PR without instruction.

## STOP conditions

- The first useful assertion requires changing the generic harness, public SDK schema, or introducing a model judge.
- Tests require live provider access, durable user data, or new tracing/storage infrastructure.
- Existing fixtures or dirty changes conflict, or focused verification fails after two bounded attempts.
