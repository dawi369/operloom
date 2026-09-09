# Naming and compatibility

Operloom was previously named Assistant-mk1. For current scope and release
notes, see [Operloom 1.0](release-1.0.md).

- Product and package names are `Operloom` and `@operloom/*`.
- `pnpm operloom` is the public CLI; `pnpm workbench` remains an alias.
- Existing `x-assistant-mk1-*` signed headers, the auth-presentation cookie,
  historical migrations, and `.assistant-mk1` local data paths are compatibility
  identifiers. Renaming them would require a coordinated protocol/data migration.
- Provider identities are configured separately. The personal deployment uses
  Operloom names; see [minimal hosted testing](minimal-hosted-testing.md).
- Native code lives on [`codex/mobile-wip`](https://github.com/dawi369/operloom/tree/codex/mobile-wip).

The rename did not change the PolyForm Noncommercial license. Local development
uses the [resource supervisor](dev-infrastructure-readiness.md); it is part of
the supported setup, not an optional workaround.
