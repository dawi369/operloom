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

To hide the bundled demo packs (`operloom`, `repo-analyst`, `baby-polymancer`,
`baby-swordfish`) from your product, mark their `workbench.config.ts` entries
`conformanceOnly: true` instead of deleting them. They stay compiled for
platform tests, which skip the cases that need them installed, and upstream
merges stay conflict-free.

## Day one checklist

Accounts you need before step 3, all with free tiers: Cloudflare (Workers,
D1, R2, Queues), a WorkOS AuthKit application (issuer, JWKS URL and client
ids come from its dashboard), an OpenRouter key, and for email a Resend
account with a verified sending domain. Log in once with `wrangler login`.
Run `pnpm install --frozen-lockfile && pnpm operloom init` first; it writes
`.env.local` and the Worker's `.dev.vars` with local signing secrets.

In this order, each step verifiable before the next:

1. **Pack.** `pnpm agent-packs:create --id my-pack --name "My Pack"`, then
   `pnpm agent-packs:test --pack my-pack`. The scaffold already has one read
   tool and workflow, a monitor trigger (off), a `memory` block with nothing
   auto-activating, one editable setting, and posts a status line to the
   fleet board. Replace the placeholder behaviour; keep the safe defaults.
2. **Identity.** `pnpm operloom fork init ... --default-pack my-pack` (the
   origin must be your public HTTPS URL), then `pnpm operloom fork --check`.
3. **Environment.** Copy `config/environments/staging.json` to
   `config/environments/<name>.json` for a Worker-only target and replace
   every identifier: the `cloudflare` block (`workerName`, `d1DatabaseName`
   and `d1DatabaseId` from `wrangler d1 create <name>`, `r2BucketName`,
   `origin`), `consoleOrigin`, the `workos` block (issuer, JWKS URL, allowed
   client ids), `mcpAllowedClientIds`, and `secretEnvironmentVariables`,
   which names the shell variables holding your OpenRouter and WorkOS API
   keys (for example `OPERLOOM_<NAME>_OPENROUTER_API_KEY`); export them
   before `secrets`. Then `pnpm environment:worker check --name <name>`,
   `migrate`, `secrets` (generates the signing secrets and pushes the named
   keys), `deploy`, `smoke`. `/health` names any variable an enabled feature
   is missing; the smoke prints the same list. Full web plus Worker targets
   use `config/environments/{acceptance,production}.json` and the
   [deployment guide](environment-separation.md).
4. **Email.** Owner notifications: `OPERLOOM_EMAIL_PROVIDER=resend`,
   `RESEND_API_KEY`, `OPERLOOM_EMAIL_FROM`. Customer email: either
   `transactionalEmailOperation({ providerId, path: "/emails" })` against a
   connection pointed at your transactional sender, or the mailbox adapters
   (`gmail`, `microsoft-graph`) by OAuth. Nothing is self-hosted.
5. **Memory policy.** In the manifest `memory` block decide `autoActivate`
   (start empty), `ttlDays` per kind and any `contentSchema`. Packs with
   `risk.financialData` propose everything by default.
6. **Outreach limits.** `transactionalEmailOperation` and `smsSendOperation`
   carry `outreach: { dailyCap: 50 }` unless you pass your own; add a
   `window` with the business's timezone. The Worker refuses sends outside
   them.
7. **Simulation first.** Agents start on the `simulation` effect target. Run
   the whole loop there, approve from the mobile Approvals tab, watch the
   fleet board, then switch the agent to `external` per connection.
8. **Gates.** `pnpm verify:fast`, `pnpm conformance:agent-system`,
   `pnpm conformance:runtime`, `pnpm test:e2e:local:release`.

## What the platform gives you

Everything below is product-neutral and already wired; a fork configures it
rather than building it.

| Surface                                                                                                                                          | Where                                                        | Fork touches                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------- |
| Memory (goals, preferences, watchlist, conclusions, notes; proposals, expiry, workspace sharing, admin tab, approvals show what a run relied on) | `/workbench/memory`, `/admin/memory`, mobile Memory tab      | manifest `memory` block                                        |
| Fleet board (status, current and last run, next tick, open approvals, tokens today, agent status lines, per-agent timeline)                      | `/workbench/fleet`, console `/fleet`, mobile Fleet tab       | `context.updates.post(text)` from workflows                    |
| Approvals with `policy_controlled` auto-run within limits                                                                                        | admin panel, mobile Approvals                                | tool `policy` block                                            |
| Monitors, schedules, webhooks, delegation between agents                                                                                         | manifest `triggers`, `context.tasks.delegate`                | declare; `context.triggers.ensure` to install on a user action |
| Artifacts with web and native renderers                                                                                                          | History panel, mobile Artifacts tab                          | `artifactRenderers` + `web.ts`, optional `native.ts`           |
| Notifications (push, email via Resend, SMS via relay)                                                                                            | `OPERLOOM_EMAIL_PROVIDER`, `OPERLOOM_NOTIFICATION_RELAY_URL` | manifest `notifications`                                       |
| Provider operations with receipts, idempotency and outreach limits                                                                               | `providerOperations`                                         | `transactionalEmailOperation`, `smsSendOperation`, `outreach`  |
| Configuration guard                                                                                                                              | `/health` problems, Worker log, `environment:worker smoke`   | fix the named variable                                         |
| Billing plans and entitlements                                                                                                                   | `config/billing.json`, Stripe or Polar                       | only for multi-tenant                                          |

## Build the product package

Put domain behavior in one Runtime Module package, registered once in
`workbench.config.ts`; product code needs no core edits. Start from the
scaffold, or from
[`examples/resource-allocator`](../examples/resource-allocator/control-plane.ts)
for the full operator loop:

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
| Durable user context     | `context.memory` (requires `memory.recall`)                  |
| Owner visibility         | `context.updates.post` lines on the fleet board              |
| Customer contact         | `providerOperations` with `outreach` limits                  |

Agents start with the `simulation` effect target, so a package can run end to
end on paper before any external binding exists. Packs use scoped execution
contexts; they never receive platform credentials or raw control-plane state.
Keep fork-only tests beside the package and run them with `pnpm test:unit`.
`createPackTestRuntime` from `cloudflare/control-plane/src/pack-test-runtime.ts`
runs workflows, queries and settings through the real control-plane code on
in-memory SQLite; see `examples/resource-allocator/loop.test.ts`.

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
pnpm environment:worker check --name <name>
```

Apply D1 migrations to each hosted target with
`pnpm environment:worker migrate --name <name>` before deploying the Worker
that expects them. Existing agent snapshots keep their behavior and limits. Use `/admin` →
**Agents** → **Use agent** to adopt a new pack version as a new instance;
existing conversations are unchanged. Incompatible snapshots keep chat access,
but execution fails closed until a compatible runtime is available.

If an update regresses your fork, redeploy the previous known-good commit.
Database recovery is separate: restore from backup rather than reversing
migrations or moving release tags.
