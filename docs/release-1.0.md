# Operloom 1.0.0

Release state: released.

The immutable `v1.0.0` tag is the adoption baseline. Published on September 9,
2026: [release](https://github.com/dawi369/operloom/releases/tag/v1.0.0) and
[passing CI](https://github.com/dawi369/operloom/actions/runs/34330781367).
Older pre-1.0 tags have been retired. The [release checklist](release-readiness.md)
defines the tested scope; advanced capabilities require separate acceptance.

I built Operloom to give agent experiments a durable home without giving up
ownership of the code. This release draws a deliberate boundary around what
I can test and explain: a developer can install the workbench, chat, run a
read-only workflow, build a pack, and carry their state through an upgrade.

## Stable contract

- Web workbench, conversation history, chat, trusted agent packs, read-only
  workflows, managed reports, and artifacts.
- Documented `@operloom/agent-sdk`, `@operloom/workbench-client`, and
  `@operloom/workbench-react` interfaces; Pack API v2 and Runtime Module v1.
- Within application 1.x, minor releases add compatible functionality and patches
  correct behavior. Breaking documented contracts require an explicit migration
  and an appropriate major version; no silent reinterpretation of saved snapshots.
- Internal implementation imports and generated files are not public APIs.
  Packs remain trusted build-time code, not sandboxed third-party plugins.
- Existing pack versions and package/API majors remain independent of application
  versioning. Workspace packages remain private and unpublished.

## Boundaries

Hosted credential brokerage, mutations, and unattended automation are
experimental and disabled by default. Enabling them requires their separate
[production acceptance](advanced-production-acceptance.md). Swordfish is a
prompt-based architecture preview, not a live market-data integration. Mobile
remains WIP on `codex/mobile-wip`.

Scalability describes independent conversation, control, and execution
boundaries—not measured throughput, availability, or a production SLA. This
release has no independent adoption evidence or guaranteed future maintenance.
The license remains [PolyForm Noncommercial 1.0.0](../LICENSE).

## Upgrade

Back up your database and configuration before updating. Review the release diff,
install with the pinned lockfile, run forward migrations, and rebuild generated
registries and workspace packages. Do not reset a retained database with
`schema.sql`. The 0.5.1 fixture upgrade gate checks conversations, settings, and
agent snapshots. See [forking and updates](forking.md).

Failures now retain workflow inputs and links to History. Empty or reasoning-only
answers are errors; output-limit truncation is explicitly incomplete. Retries are
user initiated, with no paid automatic retry or model substitution.

[Execution deadlines and recovery](runtime-deadlines.md) describe cold starts,
request timeouts, and durable cleanup with schedules disabled.
