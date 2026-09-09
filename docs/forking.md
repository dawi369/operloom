# Forking and upgrades

Start from `v1.0.0`, the supported adoption baseline. Older pre-1.0 tags have
been retired. The [1.x contract](release-1.0.md) covers documented SDK/client
interfaces, Pack API v2, and Runtime Module v1: additive minor releases,
corrective patches, and explicit migrations for breaking changes.

## Make it yours

Clone the release and connect your own empty GitHub repository:

```bash
git clone --branch v1.0.0 https://github.com/dawi369/operloom.git my-workbench
cd my-workbench
git switch -c main
git remote rename origin upstream
git remote add origin <your-repository-url>
git push -u origin main
```

Follow [local setup](getting-started.md), then configure the public identity:

```bash
pnpm operloom fork init --id my-workbench --name "My Workbench" --origin https://agents.example.com
pnpm operloom fork --check
```

This updates `config/product.json`. Keep the internal `@operloom/*` namespace
and signed protocol identifiers stable. Configure your own hosted resources
through the [deployment guide](environment-separation.md).

Put domain behavior in a [Runtime Module](first-agent.md), registered once in
`workbench.config.ts`. Packs use scoped execution contexts; they do not own
platform credentials or raw control-plane state. Workspace packages remain
private and unpublished.

## Bring in an update

Back up your database and configuration. Fetch upstream, create an update branch,
and merge the release you intend to adopt:

```bash
git fetch upstream --tags
git switch -c update/operloom main
git merge --no-commit <release-tag>
pnpm install --frozen-lockfile
pnpm operloom pack compile
```

Review the release notes and conflicts, then apply the documented
[forward migrations](migrations-and-retention.md). Never reset retained data
with `schema.sql`. Regenerate registries instead of editing generated files.
Run focused checks for your changes; `pnpm fork:check` is the comprehensive gate
for changes to the core platform. CI should pass before you deploy.

Existing agent snapshots retain their behavior and limits. In the chat composer,
use `/admin` → **Agents** → **Use agent** to adopt the current pack as a new
instance; existing conversations remain unchanged. Incompatible snapshots keep
chat access, but execution fails closed until a compatible runtime is available.

If an update regresses your fork, redeploy the previous known-good commit.
Database recovery is separate: use the backup/restore procedure rather than
reversing migrations or moving release tags.
