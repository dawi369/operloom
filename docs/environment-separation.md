# Environments And Deployment

Document status: current deployment security boundary and operator runbook.

Operloom has four explicit targets. The checked-in
`config/environments/*.json` files contain only non-secret names and environment
variable references. `cloudflare/control-plane/wrangler.jsonc` and
`fly.runner.toml` carry local defaults; the deploy commands render
target-specific configuration from the manifest.

| Target       | Customer data  | Conformance | Vault  | Mutation default |
| ------------ | -------------- | ----------- | ------ | ---------------- |
| `local`      | none           | enabled     | memory | off              |
| `acceptance` | synthetic only | enabled     | WorkOS | off              |
| `production` | allowed        | disabled    | WorkOS | off              |
| `demo`       | seven-day demo | disabled    | WorkOS | off              |

Hosted targets default to cost-idle operation: Cloudflare Cron Triggers are
empty and Fly keeps zero Machines running when idle. Scheduled and monitor
triggers remain dormant until a deliberate deployment re-enables the scheduler;
runner invocations cold-start the existing Fly Machine.

Worker names, D1 names and IDs, R2 buckets, Fly apps, web projects, WorkOS
applications/workspaces, public origins, and every signing-secret reference are
mechanically distinct. Production validation rejects conformance mode, the
memory Vault, a dev transport token, or mutation enabled globally.

## Required non-secret target variables

Replace `TARGET` with `ACCEPTANCE`, `PRODUCTION`, or `DEMO`. Vercel targets use
the Vercel identifiers; the demo uses the Railway identifiers.

```text
OPERLOOM_TARGET_D1_DATABASE_ID
OPERLOOM_TARGET_CLOUDFLARE_ORIGIN
OPERLOOM_TARGET_FLY_ORIGIN
OPERLOOM_TARGET_VERCEL_ORG_ID
OPERLOOM_TARGET_VERCEL_PROJECT_ID
OPERLOOM_TARGET_RAILWAY_PROJECT_ID
OPERLOOM_TARGET_RAILWAY_ENVIRONMENT_ID
OPERLOOM_TARGET_RAILWAY_SERVICE_ID
OPERLOOM_TARGET_WEB_ORIGIN
OPERLOOM_TARGET_WORKOS_APPLICATION_ID
OPERLOOM_TARGET_WORKSPACE_ID                  # acceptance
OPERLOOM_PRODUCTION_ACCEPTANCE_WORKSPACE_ID  # isolated production acceptance
```

The target-specific runner, callback, Agent connection, operator-alert, cookie,
Vault, and model-provider secret names in the manifest identify
provider-secret-store entries. Values never belong in the manifest, generated
config, release evidence, shell history, or CI logs. The runner accepts
callbacks only to the configured target Cloudflare origin. Every role is unique
within a target and acceptance values must differ from production values.

## Configuration and dry runs

```bash
pnpm verify:environment-config
pnpm environment:check --target acceptance
pnpm environment:render --target acceptance
pnpm environment:provision -- --target acceptance --provider cloudflare
pnpm deploy:cloudflare:bootstrap -- --target acceptance
pnpm environment:configure-secrets -- --target acceptance
pnpm deploy:cloudflare -- --target acceptance
pnpm deploy:fly -- --target acceptance
pnpm deploy:web -- --target acceptance
```

Deployment commands are dry runs unless `--execute` is supplied. A dry run
prints a confirmation token bound to the full commit, target, and phase. Actual
execution additionally requires a clean worktree and the exact token:

```bash
pnpm deploy:cloudflare -- --target acceptance --execute \
  --feature-stage disabled \
  --confirm acceptance:deploy-cloudflare:disabled:<full-sha>
```

Provisioning is separately confirmed per provider with
`acceptance:provision-<provider>:<full-sha>`. Cloudflare, Fly, and Vercel have
guarded executable commands. Railway demo provisioning is performed once in the
existing T23 workspace and its IDs are then supplied to the manifest. WorkOS
AuthKit application and organization setup remains a dashboard action; the CLI
does not pretend that a Vault object is an AuthKit application.

Vercel provisioning also converges the project to the repository contract:
Next.js with Node 24. A project left on a provider default runtime is not ready
for deployment.

For a new Worker, run the guarded Cloudflare bootstrap before configuring
secrets. It deploys the disabled feature stage with `workers_dev=false` and no
cron triggers, creating the secret attachment point without public ingress.
The final Cloudflare, Fly, and web deploy phases require same-commit secret
configuration evidence.
Bootstrap refuses a database with the durable execution schema already installed;
it cannot be used to bypass the final deployment compatibility gate.

The final Cloudflare deployment now builds a standalone artifact and uses its
durable-handler compatibility gate. Apply migration 0030 first. New durable
admissions pause during inspection/activation; existing runs continue. D1 rejects
stale Worker admissions after the new generation activates. A failed
or uncertain upload retains the fence. Keep the reported artifact and use its
`--resume` or verified `--release` command rather than bypassing the guard with a
raw deployment. See deployment compatibility.

Remote migration is a separate approval phase and requires a same-commit,
AES-256-GCM encrypted D1 export. The 32-byte base64 encryption key stays in the
operator secret store:

```bash
pnpm db:cloudflare:backup -- --target acceptance --execute \
  --confirm acceptance:backup-cloudflare:<full-sha>
pnpm db:cloudflare:migrate -- --target acceptance --execute \
  --confirm acceptance:migrate-cloudflare:disabled:<full-sha> \
  --backup-evidence output/release/<full-sha>/backups/acceptance-d1-<timestamp>.json
```

The backup JSON names `target`, `commit`, and the encrypted backup `checksum`.
Never use the reset snapshot against acceptance or production.

## Provision and promote

Record operator approval independently for each external-state phase:

1. create distinct target Worker/D1/R2/DO, Fly, web, and WorkOS resources;
2. bootstrap the acceptance Worker without public ingress or cron triggers;
3. configure provider secrets and verify target-specific secret fingerprints;
4. back up and apply forward D1 migrations;
5. deploy acceptance Cloudflare, Fly, then web from one immutable SHA;
6. promote Cloudflare through `disabled`, `retained-data`, `connections`, and
   `mutations`; each stage requires the preceding stage's same-SHA deployment
   record;
7. run the hosted acceptance checks below against the same SHA;
8. deploy the accepted SHA to production and promote only through
   `connections`. Production mutation remains globally disabled until isolated
   hosted mutation acceptance is complete; workspace-level authority checks
   remain an additional requirement after that gate is deliberately enabled.

Do not proceed if any resource, WorkOS application, secret value, or public
origin is shared across targets. Each hosted target uses its own project/service
and origin.

## Hosted acceptance

Run the local release gate on the candidate SHA first (`pnpm release:check`),
then check the deployed target:

```bash
pnpm acceptance:hosted:configuration -- --target acceptance
GITHUB_SHA=<full-sha> OPERLOOM_ENVIRONMENT=acceptance SENTRY_AUTH_TOKEN=<token> \
  pnpm acceptance:hosted:observability
OPERLOOM_HOSTED_VAULT_MODE=true GITHUB_SHA=<full-sha> OPERLOOM_ENVIRONMENT=acceptance \
  HOSTED_VAULT_WORKSPACE_ID=<synthetic-workspace> pnpm acceptance:hosted:vault
HOSTED_WEB_ORIGIN=<web-url> \
HOSTED_CLOUDFLARE_ORIGIN=<worker-url> \
HOSTED_FLY_ORIGIN=<fly-url> \
pnpm acceptance:hosted:public
```

Then complete a signed-in browser journey with a real WorkOS session: open the
web origin, send a message and confirm the thread streams, run a runner-backed
workflow such as Repository Analyst's **Readiness report**, and confirm History
shows the run, runner tool call, artifact, policy decision and audit timeline.
Server logs must not expose provider secrets. Production acceptance is
read-only and must never enable conformance mode or global mutation.

## Forward fix and rollback

- Application rollback redeploys a previously accepted artifact only when its
  schema remains forward-compatible.
- Applied D1 migrations are never rewritten or rolled down. Restore an encrypted
  backup to a fresh recovery database and promote by explicit forward fix.
- Disable workspace/pack/tool/connection mutation kill switches before changing
  code during an incident; completed external actions are not reversible.
- A failed purge resumes from its durable phase cursor. If the initiating owner
  is unavailable, use the platform-operator recovery procedure recorded in the
  deletion runbook; never reactivate the workspace to gain access.
