# Operloom 1.0 release acceptance

The release promise is a stable developer workbench, not unattended production
automation. Stable scope: web UI, chat, packs, read-only workflows, artifacts, and
history. [The 1.x contract](release-1.0.md) defines compatibility and non-claims.

## 1.0 result

Published as immutable [v1.0.0](https://github.com/dawi369/operloom/releases/tag/v1.0.0)
on September 9, 2026, from `38a928a5646d9089aace0e415aa27aa82bce6dae`.
[All CI jobs passed](https://github.com/dawi369/operloom/actions/runs/34330781367).
Local setup, pack customization, retained-data upgrade, hosted demos, cold-start
execution, and failure recovery were exercised. Minimal hosting was restored.

## Checklist for a release

1. Focused regressions cover persistent workflow failures, retained inputs and
   run links, empty/truncated chat output, timeout cleanup, and session continuity.
2. A clean checkout follows README instructions using Node 24 and the resource
   supervisor. Local chat and a repository report work without hosted accounts.
3. One disposable scaffolded pack customizes its prompt and executes a
   deterministic read-only tool/workflow without editing core code. No permanent
   additional demo, downstream project, or external-user exercise is required.
4. Fresh migrations and an upgrade from the existing 0.5.1 fixture preserve
   chats, settings, and agent snapshots through migration `0015`. Existing
   migration/backup checks pass.
5. Every existing GitHub Actions job passes on the final release commit.
   Run focused checks locally; CI owns the full suite.
6. Deploy that exact commit to Vercel, Cloudflare, and Fly. A signed-in hosted
   session exercises Operloom, Repository Analyst (from a stopped runner),
   Polymancer, Swordfish's preview, reload/reconnect, and a recoverable failure.
7. Restore minimal hosting: runner stopped, schedules disabled, notification
   delivery paused. Record commit, CI run, deployment IDs, and focused outcomes
   in ignored release evidence without credentials.
8. Only after those gates pass, publish an immutable version tag and GitHub release notes.
   Do not move published release tags or publish workspace packages.

## Separate experimental acceptance

Credential brokerage, mutations, and unattended automation remain explicitly
experimental and default off. Existing advanced conformance still runs in CI,
but is not evidence of production acceptance. Retained-data lifecycle gates,
Vault custody, mutation drills, and long-running hosted soak requirements are
kept in [Advanced production acceptance](advanced-production-acceptance.md).
Mobile remains WIP and does not block this web release.

A release is a tested contract, not a promise of independent adoption, an SLA,
or guaranteed future maintenance. No architectural rewrite, new infrastructure,
load-test claims, or permanent new demo is part of this release.
