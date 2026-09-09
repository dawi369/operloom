# Roadmap

Operloom [1.0.0](release-1.0.md) is released. The stable scope is the web
workbench, chat, trusted packs, read-only workflows, artifacts, and history.
[Architecture](architecture.md) describes the implemented system;
[release acceptance](release-readiness.md) records its verification boundary.

## Maintenance priorities

- Fix reproducible failures in setup, chat continuity, workflows, and upgrades.
- Keep the documented SDK/client interfaces, Pack API v2, and Runtime Module v1
  compatible within application 1.x.
- Keep dependencies, setup instructions, and the four demo use cases usable.

## Future work, without a delivery commitment

- Independent adoption and larger-scale performance evidence.
- Hosted credential brokerage, mutations, and unattended automation, subject to
  [separate production acceptance](advanced-production-acceptance.md).
- Richer pack-contributed views and provider integrations when a concrete use
  case needs them.
- [Mobile](mobile-frontends.md), preserved on `codex/mobile-wip`.

There is no planned architectural rewrite, marketplace, multi-region deployment,
or new core entity without a demonstrated need. This is a personal project,
without an SLA or guaranteed future maintenance.
