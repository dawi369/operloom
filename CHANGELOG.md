# Changelog

## 2.0.0 (unreleased)

Clean-slate baseline. There is no upgrade path from 1.x; rebuild databases from
the baseline schema.

- One Runtime Module contract (`defineControlPlaneModule`, `apiVersion: 2`) for
  `@operloom/agent-sdk` SDK 2.0.0. Packages declare `requirements` with
  unversioned capabilities (`workflow.request`, `state.atomic`,
  `state.migrations`, `context.snapshots`, `models.structured`,
  `usage.reservations`). The v1 module contract, its adapter and the workflow
  `engine` field are removed.
- `@operloom/workbench-client` and `@operloom/workbench-react` 2.0.0 drop the
  workflow `engine` field from run and workflow contracts.
- LangGraph is removed. The signed Node.js tool runner runs standalone from
  `runner/server.ts` (`pnpm start:runner`, `Dockerfile.runner`,
  `fly.runner.toml`).
