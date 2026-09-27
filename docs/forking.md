# Forking and upgrades

Start from `v2.0.0`. It is a clean-slate baseline: there is no upgrade path from
1.x, and databases are created from the baseline schema. Within 2.x, the SDK,
`@operloom/client`, Runtime Module and `/v1` contracts change additively, with
explicit migrations for breaking changes.

## Make it yours

Clone the release and connect your own private repository:

```bash
git clone --branch v2.0.0 https://github.com/dawi369/operloom.git my-product
cd my-product
git switch -c main
git remote rename origin upstream
git remote add origin <your-repository-url>
git push -u origin main
```

Follow [local setup](getting-started.md), then set the product identity and the
default agent every workspace starts with:

```bash
pnpm operloom fork init --id my-product --name "My Product" --origin https://app.example.com \
  --default-pack my-pack --max-agents 1
pnpm operloom fork --check
```

This updates `config/product.json`. `workspace.defaultAgentPack` is the bundled
pack each new workspace's default agent is created from; the Worker refuses to
start if it is not registered. `workspace.maxAgents` caps active agents per
workspace (`1` gives each user one agent). Keep the internal `@operloom/*`
namespace and signed protocol identifiers stable. Configure hosted resources
through the [deployment guide](environment-separation.md).

## Build the product package

Put domain behavior in one Runtime Module package, registered once in
`workbench.config.ts`; product code needs no core edits. Start from
[`examples/resource-allocator`](../examples/resource-allocator/control-plane.ts),
which has the full operator loop:

| Need                     | Runtime Module surface                                       |
| ------------------------ | ------------------------------------------------------------ |
| Operator-editable config | `settings` (schema, defaults, editable keys; pinned per run) |
| Domain records           | `state` definitions with indexes; atomic `state.commit`      |
| Minute monitors          | manifest `triggers` + `observeMonitor` cursor                |
| Evidence                 | `context` resolvers (snapshotted, freshness-checked)         |
| Decisions                | `models.structured` + decision entries                       |
| Effects                  | action bindings with `simulate`; ledger projection           |
| Client read models       | `queries`                                                    |
| Alerts                   | state `events` → webhook notifications                       |

Agents start with the `simulation` effect target, so a package can run end to
end on paper before any external binding exists. Packs use scoped execution
contexts; they never receive platform credentials or raw control-plane state.
Keep fork-only tests beside the package and run them with `pnpm test:unit`.

## Bring in an update

Back up your database and configuration. Fetch upstream, create an update
branch and merge the release you intend to adopt:

```bash
git fetch upstream --tags
git switch -c update/operloom main
git merge --no-commit <release-tag>
pnpm install --frozen-lockfile
pnpm operloom pack compile
```

Review the release notes and conflicts, then apply the documented forward
migrations. Never reset retained data with `schema.sql`. Regenerate registries
instead of editing generated files. Before you deploy, run:

```bash
pnpm verify:fast
pnpm conformance:runtime
pnpm test:e2e:local:release
```

Existing agent snapshots keep their behavior and limits. Use `/admin` →
**Agents** → **Use agent** to adopt a new pack version as a new instance;
existing conversations are unchanged. Incompatible snapshots keep chat access,
but execution fails closed until a compatible runtime is available.

If an update regresses your fork, redeploy the previous known-good commit.
Database recovery is separate: restore from backup rather than reversing
migrations or moving release tags.
