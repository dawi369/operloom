# Polymancer carry-over (temporary)

Snapshot of `~/dev/polymancer` at `f99336d` (2026-10-25), taken before that
repository was deleted. Polymancer is re-forked from Operloom `v2.1.0`; this
directory moves into that fork's `agent-packs/polymancer/`, then goes away here.

## docs/

Two files, consolidated from the old repo's eleven:

- `polymancer.md` — product, glossary, voice and guardrails, the protocols
  (interview, brief, matching, price check, paper, watch, resolution),
  experience, interface components and milestones. The spec `prompt.xml` and
  the workflows are written from.
- `system.md` — the contract: domain model, stages, settings, runtime
  surfaces, venue data sources, research pipeline, price-check math, scoring,
  errors. Wins on numbers.

Both were written against the pre-reset Operloom; concepts and rules stand,
route and SDK names should be re-checked against this repository's
`docs/headless-runtime.md` and `docs/agent-packs.md`.

## pack-source/

The `agent-packs/polymancer` code at the snapshot (no `node_modules`). It
targets the pre-reset Pack API and will not compile here; it is kept so the
domain logic, venue adapters, tests and prompt are not lost. Port by
scaffolding a fresh pack in the fork (`pnpm operloom pack create --id
polymancer`) and moving logic across file by file under
`pnpm operloom pack check --pack polymancer`.

## State when snapshotted

The old repo had M0 (copy-trading on paper: wallet tracking, simulated fills,
portfolio and operator-state queries, heartbeat and wallet monitors, live
Polymarket quotes) accepted end to end on 2026-09-27, and M1 in progress; the
last commit added watching Questions, settling and resolving outcomes, and the
scored record. Copy-trading surfaces (`copy.start`, `copy.sync`, wallet
monitors) are hidden from chat in M1 and kept for the power-user track.

Dropped from the carry-over: old platform docs and plans (superseded by this
repository), the dated competitor snapshot, the local agent notes, and GitHub
issue links (the repository and its issues are gone).
