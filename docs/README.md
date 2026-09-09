# Operloom documentation

Operloom 1.0 is a developer workbench for chat, trusted agent packs, read-only
workflows, artifacts, and history. Start here; open the deeper references when
you need to change a particular boundary.

## Start and extend

- [Getting started](getting-started.md): local setup and your first report.
- [Build your first agent](first-agent.md): scaffold and customize a pack.
- [Architecture](architecture.md): technology choices, ownership, and scaling boundaries.
- [Forking and upgrades](forking.md): adapt the project and bring in updates.
- [1.x release contract](release-1.0.md): stable interfaces and compatibility.

## Reference

- [Agent packs](agent-packs.md) · [Runtime Module v1](agent-runtime-kit.md) · [Prompt authoring](agent-profile-authoring.md)
- [Frontend integration](frontend-integration.md) · [Workbench UI](workbench-ui.md)
- [Tenancy and authorization](tenancy.md) · [Cloudflare control plane](cloudflare-control-plane.md)
- [Architecture diagrams](diagrams/README.md) · [Decisions](decisions/)

## Operate

- [Deployment](environment-separation.md) · [Vercel](deployment-vercel.md) · [Fly](deployment-fly.md)
- [Minimal hosted testing](minimal-hosted-testing.md): keep the personal demo small.
- [Migrations and retention](migrations-and-retention.md): preserve existing data.
- [Troubleshooting and resource limits](dev-infrastructure-readiness.md) · [Execution deadlines](runtime-deadlines.md)
- [Release checklist](release-readiness.md) · [Dependency security](dependency-security.md)

## Future work

[The roadmap](implementation-roadmap.md) separates future work from the stable
release. Credential brokerage, mutations, and unattended automation are
experimental and disabled by default; see [advanced acceptance](advanced-production-acceptance.md).
[Mobile remains WIP](mobile-frontends.md).

The remaining design contracts and [reference-app studies](reference-apps/) are
background material, not additional setup steps or production guarantees.
