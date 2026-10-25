# Polymancer: local agent notes

Local-only context for this checkout (excluded via `.git/info/exclude`; never
commit it). The committed `AGENTS.md` comes from Operloom and still applies.
Last updated 2026-09-28.

## What this is

- **Operloom** (`~/dev/operloom`, `github.com/dawi369/operloom`, public) is a
  product-neutral agent platform: Cloudflare control plane, Next.js web console,
  signed Node runner, WorkOS auth.
- **Polymancer** (`~/dev/polymancer`, `github.com/dawi369/polymancer`, private)
  is a product built on it. It paper-trades Polymarket by copying tracked
  wallets under the user's strategy and risk limits, one agent per workspace.
- It is a fork in git terms only. GitHub shows no "forked from" link because
  both repos are on the same account and this one is private. Remotes:
  `origin` = Polymancer, `upstream` = Operloom.
- `upstream` is fetch-only on purpose (its push URL is set to an invalid value).
  On 2026-09-27 a push from this checkout landed Polymancer code on public
  Operloom `main`. Never re-enable pushing to `upstream`; platform fixes are
  committed and pushed from `~/dev/operloom`.

## Where changes go

The split is the point of the setup: Polymancer adds a product, never a
different platform. Keep it that way so upstream merges stay conflict-free.

- **Polymancer-only** (edit here): `agent-packs/polymancer/`,
  `config/product.json`, `workbench.config.ts`, fork-only plans in `plans/`, and
  the fork's CHANGELOG entries. `generated/agent-runtime/*` is regenerated with
  `pnpm operloom pack compile`, never hand-edited.
- **Platform** (fix in `~/dev/operloom`, not here): anything under
  `cloudflare/`, `app/`, `components/`, `lib/`, `packages/`, `runner/`,
  `scripts/`, `tests/`, `docs/`, root tooling, dependencies.
  - Write the fix as a generic Operloom change: no Polymarket or Polymancer
    names in Operloom main (the `baby-polymancer` demo pack is the only
    exception).
  - Run Operloom's gates, push Operloom `main`, then merge it here.
- If a pack needs something the Runtime Module contract can't express, that is a
  platform gap: extend the contract upstream instead of working around it in the
  pack.

## Syncing from Operloom

```bash
git fetch upstream
git merge upstream/main
pnpm install --frozen-lockfile
pnpm operloom pack compile   # only if pack registries changed
pnpm -s verify:fast
```

For UI or runtime changes, also run `pnpm conformance:runtime` and
`pnpm test:e2e:local:release`. The fork's upstream-only pack specs skip by
design.

Development does not wait on CI. Local checks are the gate: push and keep
working, and only look at GitHub Actions when it reports a failure or before
a release.

## Decisions already made

- No users and no retained data: breaking changes are fine. Don't write
  compatibility shims or data migrations for history.
- WorkOS is the only identity provider. Supabase from the old app is not
  carried over.
- Paper trading only. Agents start on the `simulation` effect target; under
  `external` the workflows fail closed with `live_trading_unavailable`. Live
  order placement is future product work and needs its own design (credentials
  through the vault and broker, action review).
- Monitors are minute-scale scheduled triggers, not persistent collectors.
- LangGraph was removed from Operloom; the signed runner handles heavy tools.

## Status

- Done: the local end-to-end paper loop (copy start, sync, fills, portfolio,
  and a heartbeat that marks positions to live Gamma quotes).
  - As of 2026-10-01 the fork passes `verify:fast` and every CI browser
    conformance suite locally (agent-system 14/14).
  - Dependency updates land in Operloom first and merge down; close
    Dependabot PRs opened on this repo as superseded.
- Not done (the next milestone is a pseudo-prod deploy of Polymancer itself;
  Operloom gaps found there are patched upstream):
  - Hosted deploy and smoke.
  - WorkOS Google sign-in (only local auth has been exercised).
  - A WorkOS JWT template to put the user's email in the access token.
  - GitHub Actions secrets for this new repo (none exist yet).
- Canonical status and roadmap: the Status section of `plans/operloom-reset.md`
  (committed; keep it current). Fork mechanics: `docs/forking.md`.

## Legacy Polymancer

- The pre-Operloom app (Bun, Supabase, Expo, Railway) is archived in
  `~/dev/_archive/polymancer-legacy`.
- Its old GitHub repo was deleted. Full mirror backups and a PR export are in
  `~/dev/_archive/` (`polymancer-remote.git`, `polymancer-remote-prs.json`).
- Use it only as a reference for domain rules. `domain.test.ts` already ports
  its expected fill and PnL values.
- Don't copy code, env files or keys from it. Its secrets are stale.

## Machine notes

- macOS, zsh, pnpm 10. `ls` is aliased to eza; use `command ls` in scripts.
- pnpm enforces a ~7-day `minimumReleaseAge`. Don't bypass it; choose the newest
  version older than 7 days.
- Pushing: if the default credential helper fails, use
  `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push`.
- Set `GH_PAGER=cat` for `gh` commands.
- Run browser suites and Docker builds one at a time, never in parallel.
