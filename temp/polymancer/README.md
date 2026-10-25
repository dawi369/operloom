# Polymancer carry-over (temporary)

Snapshot taken 2026-10-25 from `~/dev/polymancer` at `f99336d` before that
repository is deleted. Polymancer will be re-forked from Operloom `v2.1.0`;
this directory is the material to carry into that fork, then delete from here.

## docs/ — keep

Product knowledge, written against the pre-reset Operloom. Concepts, voice,
flows, components, domain model and roadmap all still apply; platform details
(routes, SDK names) should be re-checked against `docs/headless-runtime.md`
and `docs/agent-packs.md` in this repo.

| File | What it is |
| --- | --- |
| `product.md` | Positioning, who it is for, what it does and does not do |
| `agent.md` | Voice, research and judgment policy; the source `prompt.xml` is written from |
| `experience.md` | The three places and end-to-end flows |
| `interface.md` | Component rules (one card every surface, three labelled numbers, plain-language odds) |
| `system.md` | Authoritative contract: domain model, stages, settings, math, scoring, errors |
| `roadmap.md` | Milestones M1… and the tickets that prove each |
| `glossary.md` | Definitions (was `CONTEXT.md`) |
| `pack-readme.md` | The pack's public README |
| `product-changelog.md` | What shipped, in order (the old repo's `CHANGELOG.md`) |
| `local-notes-2026-09-28.md` | Uncommitted local agent notes from the old checkout; context only, partly stale |

## pack-source/ — reference only

The `agent-packs/polymancer` code at the snapshot commit, minus `node_modules`,
`docs/`, `CONTEXT.md` and `README.md` (moved above). It targets the pre-reset
Pack API and will not compile here as-is; it is kept so domain logic, tests,
venue adapters and the prompt are not lost. Port by scaffolding a fresh pack in
the fork (`pnpm operloom pack create --id polymancer`) and moving logic across
file by file, running `pnpm operloom pack check --pack polymancer` as you go.

## Not carried

- `docs/`, `packages/*/README.md`, `CONTRIBUTING.md`, `AGENTS.md`: old platform
  docs, superseded by this repository.
- `plans/operloom-reset.md`, `plans/operloom-runtime-v1-superseded.md`:
  platform plans, already realised here.
- GitHub issues (the "Wayfinder" planning map, roadmap tickets): the repo is
  private and they are not readable from here. `roadmap.md` and
  `product-changelog.md` link to five of them; export them before deleting
  the repository if the discussion matters.

Delete this directory once the fork has absorbed it.
