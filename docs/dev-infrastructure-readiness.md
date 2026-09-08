# Dev Infrastructure Readiness

This checklist tracks local infrastructure and hosted target prerequisites.
Hosted resource ownership is defined by `config/environments/*.json` and the
promotion runbook in `environment-separation.md`; this file is not a deployment
default.

## Hosted target baseline

- Fly runtime apps: distinct `assistant-mk1-acceptance-runner` and
  `assistant-mk1-production-runner`
- Region: `fra`
- Runtime URL: the target-specific `WORKBENCH_TARGET_FLY_ORIGIN`
- Runtime shape: one Fly Machine runs the gateway and LangGraph dev server.
- Vercel frontend: distinct protected acceptance and production projects
- Hosted auth: WorkOS AuthKit on Vercel; WorkOS `user.id` maps to internal
  `userId`. WorkOS `organizationId` maps to `workos-org:<organizationId>` when
  present. Pre-user sessions without an organization use
  `workos-personal:<user-id>`. Cloudflare creates the account's default
  workspace, stores the user's active workspace preference, and resolves the
  active workspace from D1.
- Required public evidence: `pnpm acceptance:hosted:public` with the Vercel,
  Cloudflare, and Fly URLs for the same commit.
- Cloudflare Workers: distinct acceptance and production names
- Cloudflare D1/R2/DO: distinct acceptance and production resources
- D1 binding: `DB`
- Sentry: org `t23`, project `operloom`. Vercel and Cloudflare share the
  project and are separated by `runtime.surface` tags.
- Runtime evidence aliases:
  - `pnpm conformance:agent-system` exercises package execution through the
    local Next, Worker, signed runner, callback, and D1 boundaries.
  - `pnpm smoke:cloudflare-deploy-readiness` checks the minimum remote Worker
    identity, policy, session, and event boundaries without creating a pack run.

The Vercel frontend uses the same Cloudflare-owned workbench routes. Its
LangGraph proxy points at the target Cloudflare `/langgraph` facade, which
authenticates Vercel with a target-specific signed facade secret and then
authenticates to the target Fly gateway with `LANGGRAPH_UPSTREAM_TOKEN`.

Hosted Vercel requests derive tenant scope from the WorkOS server session.
Users must complete WorkOS sign-in before the workbench can call Cloudflare.
When WorkOS provides an organization, that organization is treated as the
customer/company account source. During the current pre-user phase, sessions
without an organization use a stable personal account fallback. Cloudflare
auto-bootstraps D1-backed user, default workspace, initial active membership,
and default agent rows for the current dev environment. Hosted WorkOS traffic
does not use `WORKBENCH_DEV_WORKSPACE_ID` or `WORKBENCH_DEV_AGENT_ID`;
Cloudflare resolves the active workspace and active agent from D1, falling back
to account/workspace defaults when no user preference exists.

Normal chat/session state is Cloudflare-owned. `WorkbenchSessionAgent` owns
session snapshots, recent thread summaries, active-thread selection, and the
short-lived session event stream. `WorkbenchThreadChatAgent` owns per-thread
hot messages and streaming. D1 mirrors compact chat run, policy, trace,
tool-runner, and event metadata for Admin visibility. The `/langgraph` facade
remains for compatibility and explicit Fly/LangGraph delegation, not the normal
chat path.

## Toolchain And CI

- Package manager: `pnpm@10.33.0`, pinned in `package.json`.
- pnpm project settings live in `pnpm-workspace.yaml`. pnpm v11 no longer reads
  the legacy `package.json` `pnpm` settings field, so overrides and run checks
  belong in the workspace file.
- `verifyDepsBeforeRun: warn` keeps normal `pnpm <script>` commands usable in
  non-TTY agent sessions even when local `node_modules` metadata is stale.
- GitHub Actions verification lives in `.github/workflows/verify.yml` and runs
  a clean install, agent-pack validation, focused workflow/tool-policy tests,
  typecheck, lint, and build on push/PR.

If local commands warn that `node_modules` is out of sync, a deliberate
`pnpm install` refreshes the local metadata. Do not run install just to silence
the warning during unrelated repo analysis.

## Fly Configuration

Required secrets:

- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`
- `WORKBENCH_RUNNER_SIGNING_SECRET`
- `WORKBENCH_CALLBACK_SIGNING_SECRET`
- `LANGGRAPH_PROXY_TOKEN`

Optional secrets:

- `LANGSMITH_API_KEY`
- `LANGSMITH_TRACING`
- `LANGSMITH_PROJECT`
- `SENTRY_DSN`
- `SENTRY_ENVIRONMENT`
- `SENTRY_TRACES_SAMPLE_RATE`

Committed Fly env:

- `LANGGRAPH_PORT=2024`
- `LANGGRAPH_UPSTREAM_URL=http://127.0.0.1:2024`
- target-specific `OPENROUTER_APP_NAME`
- target-specific Fly `OPENROUTER_SITE_URL`

## Local Cloudflare Control Plane

The local Cloudflare loop uses Wrangler with a local D1 binding named `DB` and
the same Worker run-control routes as remote dev. It remains the cheapest inner
loop for Worker changes.

Initialize and start the complete local path:

```bash
pnpm workbench init
# Set OPENROUTER_API_KEY in both generated local environment files.
pnpm workbench doctor --offline
pnpm workbench dev
```

The migration command applies only unapplied files and preserves local dev D1
state. Use `pnpm db:cloudflare:rebuild:local` only for a deliberate destructive
reset.

`workbench dev` supervises the ordinary deployed-shape local services:

- Next.js at `http://localhost:3000`;
- LangGraph at `http://localhost:2024`;
- Cloudflare at `http://localhost:8787`;
- the signed runner gateway at `http://localhost:3101`.

Run `pnpm workbench doctor` in another terminal. It verifies the provider keys,
Worker and D1 identity path, LangGraph health, signed runner health, and matching
local transport secrets without printing their values.

Then smoke the same Cloudflare-owned path locally:

```bash
pnpm conformance:agent-system
```

That conformance gate starts at the Next facade, creates the run in the local
Cloudflare Worker, delegates Fly-bound tools to the signed local runner
gateway, receives callbacks, and reads the completed run snapshot from D1.

To prove D1 tenant isolation at the Worker boundary, run:

```bash
pnpm smoke:tenant-isolation
pnpm smoke:cloudflare-authz
pnpm smoke:cloudflare-workspace-context
pnpm smoke:cloudflare-workspaces
pnpm smoke:cloudflare-membership-policy
pnpm smoke:cloudflare-agent-selection
pnpm smoke:cloudflare-session-boundary
pnpm smoke:cloudflare-chat-boundary
pnpm smoke:cloudflare-policy-boundary
pnpm smoke:cloudflare-event-feed
pnpm smoke:cloudflare-event-stream
```

Those smokes use two trusted dev tenant identities. They verify each tenant sees
only its own workbench runs, chat sessions, and LangGraph chat threads. The
authz smoke verifies the WorkOS-shaped no-agent-header path auto-bootstraps
D1-backed user/workspace/membership/default-agent rows, reuses the active
agent, rejects disabled membership, and hides cross-workspace sessions. The
workspace, membership-policy, agent-selection, and admin-summary smokes verify
Cloudflare-owned workspace activation, D1-owned membership authorization,
active-agent preferences, and the Admin summary path. The
workspace-context smoke verifies the same resolved identity is exposed safely
for Admin before any control run exists. The policy smoke also verifies
that normal `ask` chat passes, `execute` chat is
blocked, and duplicate same-thread execution is rejected while a run is already
`running`. The event-feed smoke verifies tenant-scoped progress events and the
`after` cursor route. The event-stream smoke verifies the same progress can be
observed over the Worker SSE stream.

The local Worker code is split by responsibility: route dispatch, HTTP/auth
helpers, the compiled runtime workflow/tool kernel, atomic D1 lifecycle, and
approval recovery.

## Hosted Cloudflare Control Plane

Each acceptance or production target proves this production-shaped path:

```text
Vercel Next proxy -> remote Cloudflare Worker -> remote D1
                  -> signed Fly runtime executor
                  -> Worker callbacks -> remote D1 snapshot
```

Provisioning and deploy commands:

```bash
pnpm wrangler d1 list
pnpm wrangler d1 create assistant_mk1_acceptance
pnpm environment:check --target acceptance
pnpm db:cloudflare:migrate -- --target acceptance
pnpm deploy:cloudflare -- --target acceptance
```

The migration command uses Wrangler's `d1_migrations` ledger and preserves
existing rows. It is a dry run until separately approved and requires
same-commit backup evidence before `--execute`. No hosted rebuild command is
available.

Only run `d1 create` in an approved provisioning phase. Store the returned ID
in the target environment variable, never in the local Wrangler config.

Remote Worker secrets and vars:

```bash
pnpm wrangler secret put CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN --config cloudflare/control-plane/wrangler.jsonc
pnpm wrangler secret put CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET --config cloudflare/control-plane/wrangler.jsonc
pnpm wrangler secret put LANGGRAPH_UPSTREAM_TOKEN --config cloudflare/control-plane/wrangler.jsonc
pnpm wrangler secret put WORKBENCH_CALLBACK_SIGNING_SECRET --config cloudflare/control-plane/wrangler.jsonc
pnpm wrangler secret put WORKBENCH_RUNNER_TRANSPORT --config cloudflare/control-plane/wrangler.jsonc
pnpm wrangler secret put WORKBENCH_RUNNER_URL --config cloudflare/control-plane/wrangler.jsonc
pnpm wrangler secret put WORKBENCH_RUNNER_SIGNING_SECRET --config cloudflare/control-plane/wrangler.jsonc
pnpm wrangler secret put SENTRY_DSN --config cloudflare/control-plane/wrangler.jsonc
```

Use `<target-fly-origin>/workbench/tool-runners/invocations` as the remote
runner URL when enabling `WORKBENCH_RUNNER_TRANSPORT=fly`.
`WORKBENCH_RUNNER_SIGNING_SECRET` must match the Fly secret with the same name.
When the transport, URL, or secret is absent, Fly-bound tools are unavailable;
the Worker never falls back to inline execution for a Fly declaration.

Verify runner transport without printing secrets by setting the secret only in
the command environment:

```bash
LANGGRAPH_RUNTIME_BASE_URL=<target-fly-origin> \
WORKBENCH_RUNNER_SIGNING_SECRET=<runner-secret> \
pnpm smoke:fly-tool-runner
```

Fly machine health uses the shallow `GET /health/live` endpoint. The deeper
`GET /health` endpoint still checks LangGraph readiness and is the right manual
check when debugging runtime boot or proxy behavior.

`LANGGRAPH_UPSTREAM_URL` is rendered from the selected environment manifest.
`LANGGRAPH_UPSTREAM_TOKEN` must match the target Fly `LANGGRAPH_PROXY_TOKEN`.

`CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET` must match the Vercel
Production environment variable with the same name. When this secret is present,
normal control-plane facade routes require fresh signed requests and reject
stale or replayed nonces. Local `wrangler dev` can keep using the dev token only
when this signing secret is absent or `CLOUDFLARE_CONTROL_PLANE_REQUIRE_FACADE_SIGNATURE=false`.

`SENTRY_ENVIRONMENT` is rendered from the selected target. Keep `SENTRY_DSN`
out of source and configure it as a target Worker secret.
`SENTRY_TRACES_SAMPLE_RATE=0.02` is committed for the deployed Worker to keep
production telemetry low-noise.

The old remote dev-token smoke path is intentionally unavailable. Hosted
verification uses fresh facade signatures and the protected target workflow:

```bash
pnpm environment:check --target acceptance
pnpm acceptance:hosted:level3:preflight
pnpm acceptance:hosted:public
WORKBENCH_HOSTED_DRILL_MODE=true pnpm acceptance:hosted:level3
```

The signed-in WorkOS browser journey separately activates Repository Analyst,
completes its workflow through Fly, and inspects the History artifact. Missing
Cloudflare or runner configuration fails visibly; there is no local
compatibility execution route.

Tenant scope for the hosted Vercel baseline is server-derived from WorkOS
AuthKit. Vercel/Next maps WorkOS `user.id` to internal `userId` and WorkOS
`organizationId` to `workos-org:<organizationId>` when present. During pre-user
development, signed-in WorkOS sessions without an organization fall back to a
stable `workos-personal:<user-id>` account. Vercel forwards those values and
safe user/membership metadata to the Worker as trusted headers. Cloudflare
resolves the active workspace, membership, and active agent from D1 before
reading or writing control-plane state. Browser requests never choose tenant
scope, workspace identity, or agent identity. In the B2B north star,
WorkOS organizations represent customer or company account sources; one account
has one default workspace now and can have multiple workspaces later. The WorkOS
client id and API key must come from the same WorkOS app/environment, and the
Vercel Production redirect URI must be
`https://operloom.vercel.app/auth/callback`.

Local development can still fall back to `WORKBENCH_DEV_USER_ID` and
`WORKBENCH_DEV_WORKSPACE_ID` when WorkOS is not configured. That fallback is
for local smoke convenience only; hosted Vercel should use WorkOS session
identity.

## Runtime Tool Foundation

Compiled Runtime Module v1 declarations are the only pack tool catalog. The
Cloudflare kernel enforces scope, policy, approvals, schemas, lifecycle, and
publication; Fly imports the separate executable runner registry and returns
signed progress/artifact evidence.

## Artifact R2 Resource

The selected environment manifest binds `ARTIFACTS` to one target-only bucket:
`assistant-mk1-local-artifacts`, `assistant-mk1-acceptance-artifacts`, or
`assistant-mk1-production-artifacts`. Local development and deterministic
conformance use isolated R2 persistence. Configuration verification never
creates a hosted bucket.

The object key is
`tenants/<userId>/<workspaceId>/artifacts/<artifactId>`. Cloudflare alone owns
the binding; Fly/LangGraph do not receive broad R2 credentials. D1 stores the
provider, key, SHA-256, size, retention class, expiry, and tombstone. Reads and
exports re-authorize the tenant through Cloudflare.

Before the first hosted R2 deployment, use the guarded acceptance provisioning,
encrypted D1 backup, forward migration, deployment, and data-lifecycle evidence
commands in `environment-separation.md`. Production provisioning is a separate
approval and cannot reuse the acceptance bucket or D1 database.

## Remaining infrastructure exclusions

- multi-region failover and automatic cross-environment promotion;
- direct D1/R2 access from Fly or LangGraph workers;
- real financial or trading providers;
- Cloudflare Agent or Durable Object classes outside the two declared bindings.
