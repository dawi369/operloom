# Operloom: web-focused release

Operloom is the new name for Assistant-mk1. The repository and package namespace
are now `dawi369/operloom` and `@operloom/*`. The application is `1.0.0`; see the [stable workbench release contract](release-1.0.md).

## Scope

The supported path is the web workbench, shared TypeScript clients, trusted
agent packs, and the existing Cloudflare/Node execution boundaries. The native
Expo app and its build scripts are preserved on
[`codex/mobile-wip`](https://github.com/dawi369/operloom/tree/codex/mobile-wip).
Mobile is WIP and no longer installs or blocks verification on main.

## Compatibility

- Existing `pnpm workbench` commands remain valid. `pnpm operloom` is the public
  command alias used by the introduction and tutorials.
- Workspace package imports change to `@operloom/*`. Downstream consumers must
  update their imports and reinstall/rebuild together.
- Existing `x-assistant-mk1-*` signed transport headers remain unchanged. They
  are protocol identifiers, not UI branding. Keeping them avoids an accidental
  mixed-version authorization or callback outage.
- Hosted resources use Operloom names after an explicit migration; see
  [Minimal hosted testing](minimal-hosted-testing.md). Retained rollback copies
  keep their historical names until retired. Auth redirects must be configured
  in WorkOS before changing the frontend callback.
- The auth-presentation cookie and `.assistant-mk1` local data directory remain
  compatibility identifiers. Forks configure their own provider identities.
- Historical migrations and server bearer/notification contracts remain. They
  support shared clients and retained data even while native delivery is deferred.
- Hosted cron triggers remain disabled and Fly retains zero running Machines
  when idle. Enable schedules intentionally; account for runner cold starts.

The repository uses PolyForm Noncommercial 1.0.0. The rebrand does not alter
licensing or grant new commercial rights.

## Release discipline

Run the repository checks, browser journeys, and extended conformance before
publishing claims about those boundaries. Hosted mutation, credential custody,
data lifecycle, and reliability claims still require the recorded hosted
acceptance evidence in [Advanced production acceptance](advanced-production-acceptance.md).

The goal is a bounded, understandable project that can be adapted without its
author present. Provider APIs and dependencies still require maintenance; the
project does not promise indefinite unattended compatibility or an SLA.

## Development safety

The web development default is Webpack after reproducing runaway Turbopack
CSS/loader workers on both Node 24 and 26. Production builds retain the verified
Next.js build path. Development disables Node server source-map consumption
(`--disable-source-maps`); browser source maps remain available. This trades
mapped server stack traces for a bounded local memory footprint. Sentry build
transforms run in production only, and the server SDK is externalized.
Supervised development and browser services have process/RSS budgets on
macOS/Linux, bounded logs, and whole-process-group cleanup on failure
or cancellation. Small bounded tests verify budget enforcement and removal of
grandchildren. Docker and browser checks run sequentially.
