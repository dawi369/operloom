# Environment Separation And Release Evidence

Document status: current deployment security boundary and operator runbook.

Operloom has four explicit targets. The checked-in
`config/environments/*.json` files contain only non-secret names and environment
variable references. `cloudflare/control-plane/wrangler.jsonc` and
`fly.langgraph.toml` are local-only; neither is a hosted deployment default.

| Target       | Customer data  | Conformance | Vault  | Mutation default |
| ------------ | -------------- | ----------- | ------ | ---------------- |
| `local`      | none           | enabled     | memory | off              |
| `acceptance` | synthetic only | enabled     | WorkOS | off              |
| `production` | allowed        | disabled    | WorkOS | off              |
| `demo`       | seven-day demo | disabled    | WorkOS | off              |

Hosted targets default to cost-idle operation: Cloudflare Cron Triggers are
empty and Fly keeps zero Machines running when idle. Scheduled and monitor
triggers remain dormant until a deliberate deployment re-enables the scheduler;
explicit LangGraph or runner traffic cold-starts the existing Fly Machine.

Worker names, D1 names and IDs, R2 buckets, Fly apps, web projects, WorkOS
applications/workspaces, public origins, and every signing-secret reference are
mechanically distinct. Production validation rejects conformance mode, the
memory Vault, a dev transport token, or mutation enabled globally.

## Required non-secret target variables

Replace `TARGET` with `ACCEPTANCE`, `PRODUCTION`, or `DEMO`. Vercel targets use
the Vercel identifiers; the demo uses the Railway identifiers.

```text
WORKBENCH_TARGET_D1_DATABASE_ID
WORKBENCH_TARGET_CLOUDFLARE_ORIGIN
WORKBENCH_TARGET_FLY_ORIGIN
WORKBENCH_TARGET_VERCEL_ORG_ID
WORKBENCH_TARGET_VERCEL_PROJECT_ID
WORKBENCH_TARGET_RAILWAY_PROJECT_ID
WORKBENCH_TARGET_RAILWAY_ENVIRONMENT_ID
WORKBENCH_TARGET_RAILWAY_SERVICE_ID
WORKBENCH_TARGET_WEB_ORIGIN
WORKBENCH_TARGET_WORKOS_APPLICATION_ID
WORKBENCH_TARGET_WORKSPACE_ID                  # acceptance
WORKBENCH_PRODUCTION_ACCEPTANCE_WORKSPACE_ID  # isolated production acceptance
```

The target-specific facade, runner, callback, Agent connection, alert receiver,
cookie, proxy, Vault, and model-provider secret names in the manifest identify
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
existing T23 workspace and its IDs are then supplied to the manifest. WorkOS AuthKit application and organization setup
remains a dashboard action and must be recorded with
`pnpm release:evidence:record`; the CLI does not pretend that a Vault object is
an AuthKit application.

Vercel provisioning also converges the project to the repository contract:
Next.js with Node 24. A project left on a provider default runtime is not ready
for deployment.

For a new Worker, run the guarded Cloudflare bootstrap before configuring
secrets. It deploys the disabled feature stage with `workers_dev=false` and no
cron triggers, creating the secret attachment point without public ingress.
The final Cloudflare, Fly, and web deploy phases require same-commit secret
configuration evidence.

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
7. collect all acceptance evidence and complete the 24-hour soak;
8. deploy the accepted SHA to production and promote only through
   `connections`. Production mutation remains globally disabled until isolated
   hosted mutation acceptance is complete; workspace-level authority checks
   remain an additional requirement after that gate is deliberately enabled.

Do not proceed if any resource, WorkOS application, secret value, or public
origin is shared across targets. Each hosted target uses its own project/service
and origin.

## Same-commit evidence

Run gates through the recorder so duration, status, operator, target, and SHA
are durable without recording environment values:

```bash
pnpm release:evidence:run -- --target acceptance --kind repository.release-check \
  -- pnpm release:check
pnpm release:evidence:run -- --target acceptance --kind hosted.data-lifecycle \
  -- env WORKBENCH_HOSTED_DATA_LIFECYCLE_MODE=true pnpm acceptance:hosted:data-lifecycle
pnpm release:evidence:run -- --target acceptance --kind hosted.alert-outage-redelivery \
  -- env WORKBENCH_HOSTED_ALERT_REDELIVERY_MODE=true pnpm acceptance:hosted:alert-redelivery
pnpm release:evidence:collect -- --target acceptance
```

Manual and hosted acceptance records may add secret-free service versions,
run/artifact/proposal/job identifiers, screenshots, dashboards, and artifact
paths using the same record schema. The collector rejects mixed commits or
targets and writes `output/release/<full-sha>/manifest.json`. The directory is
ignored; attach it to the protected release evidence store.

Start the acceptance soak, retain its state artifact, and finish it no earlier
than 24 elapsed hours later against the same SHA:

```bash
WORKBENCH_HOSTED_SOAK_MODE=true pnpm acceptance:hosted:soak -- --phase start
WORKBENCH_HOSTED_SOAK_MODE=true pnpm acceptance:hosted:soak -- --phase finish \
  --state output/release/<full-sha>/soak-24h-state.json
pnpm release:evidence:record -- --target acceptance --kind hosted.soak-24h \
  --input output/release/<full-sha>/soak-24h.json \
  --confirm acceptance:hosted.soak-24h:<full-sha>
```

The guarded `Hosted release evidence` workflow exposes `soak-start` and
`soak-finish`; the finish run consumes the start run's protected artifact.
Required evidence also includes duplicate delivery, receiver outage and
redelivery, Worker/Fly restart, lease expiry/replay, lifecycle alert
acknowledgement, export recovery and purge, Vault lifecycle, mutation
reconciliation, and signed-in browser acceptance. Local time-shifts are not
substitutes.

Signed-in browser acceptance remains an operator observation because it uses a
real WorkOS session. Record it with a secret-free JSON input containing
`schemaVersion: 1`, target, full commit, `status: "passed"`, start/completion
timestamps, operator, screenshot `artifactPaths`, safe service versions, and
the run/artifact IDs. Then bind it to the commit:

```bash
pnpm release:evidence:record -- --target acceptance --kind hosted.signed-in \
  --input output/release/<full-sha>/signed-in-input.json \
  --confirm acceptance:hosted.signed-in:<full-sha>
pnpm release:evidence:record -- --target production --kind hosted.signed-in-readonly \
  --input output/release/<full-sha>/production-signed-in-input.json \
  --confirm production:hosted.signed-in-readonly:<full-sha>
```

The recorder rejects mixed targets/commits, missing artifacts, invalid elapsed
time, and credential-shaped content. Production acceptance is read-only and
must never enable conformance mode or global mutation.

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
