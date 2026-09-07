# Getting started

The shortest useful first session is: start the local workspace, send a message,
then run a Repository Analyst workflow and inspect its report in History.

## Prerequisites

- Node.js 24 LTS and pnpm 10.33.0 (Node 26 is accepted locally).
- An OpenRouter API key for model responses.
- `rg` (ripgrep) available on PATH for repository inspection.
- Free local ports: 3000 (web), 2024 (LangGraph), 8787 (Worker), 3101 (runner).

You do not need Vercel, Fly, WorkOS, or a hosted Cloudflare account to use the
local identity and emulated database. Deployment requires your own accounts.

## Initialize

```bash
pnpm install --frozen-lockfile
pnpm operloom init
```

The initializer creates `.env.local` and `cloudflare/control-plane/.dev.vars`,
generates matching local transport secrets, and migrates the local D1 database.
It preserves existing values and data. `pnpm operloom init --check` inspects an
existing checkout without creating files or applying migrations.

Set `OPENROUTER_API_KEY` in both generated files. Keep it server-side; never
rename it to a `NEXT_PUBLIC_*` variable. Do not commit either file.

```bash
pnpm operloom doctor --offline
pnpm operloom dev
```

Visit [localhost:3000](http://localhost:3000), then run `pnpm operloom doctor`
in another terminal. The command checks configuration and reachable services;
it does not certify hosted security or operational readiness.

## First useful workflow

1. Open the agent picker and select **Repository Analyst**.
2. Open **Tools** and choose its repository-readiness workflow.
3. Review the bounded inputs and run it.
4. Open **History** to inspect the run, its result, and the readiness artifact.

The runner inspects the repository it is configured to mount. It does not gain
arbitrary access to another user's machine. A readiness report inventories
evidence; it does not claim that your deployment is healthy.

## When something goes wrong

| Symptom                                       | Check                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A required port is occupied                   | Identify the process using that port, stop your previous development instance, and rerun `pnpm operloom dev`.                                                 |
| Chat reports a provider/configuration failure | Set the OpenRouter key in both generated files and restart development. Check `pnpm operloom doctor`.                                                         |
| The web page opens but tools do not run       | Use the complete `pnpm operloom dev` command; the standalone Next.js command does not start the Worker or runner.                                             |
| An old local runner configuration is rejected | Rerun `pnpm operloom init`; it upgrades the retired inline runner configuration while preserving credentials.                                                 |
| Hosted sign-in fails                          | Check the exact WorkOS callback URL and environment-specific configuration in [Tenancy](tenancy.md). Local identity is intentionally unavailable when hosted. |
| A schedule does not fire                      | Hosted cron triggers default to an empty list for cost control. Explicitly enable scheduling in your deployment configuration.                                |

For runtime logs and service-specific checks, see
[Infrastructure readiness](dev-infrastructure-readiness.md). Avoid database
rebuild commands when debugging: they intentionally destroy local tables.

The local web and LangGraph development servers bind to loopback. Without
WorkOS credentials, the explicitly enabled local identity owns the development
workspace. Configured WorkOS credentials take precedence; production and hosted
environments reject the local fallback.

## Local resource limits

Allow at least 10 GiB of available memory for the complete local stack and browser.
The service ceilings total 8.5 GiB; normal use is lower. Run individual services
when working on one boundary.

Development and browser acceptance use Webpack. The Turbopack development path
produced runaway CSS/loader worker processes during verification on this Mac
under both Node 24 and 26; it is not the default development path.

On macOS/Linux the supervisor samples each service's process group every 200 ms.
It stops the entire group above 24 processes or 5 GiB combined resident memory
for the web compiler, with a 3 GiB Node heap ceiling. Node server source-map
processing is disabled in development; browser source maps remain available.
The local Worker has a 1.5 GiB budget; other services have a 1 GiB limit. The same
budgets apply to development and tests. It also cleans up grandchildren on
cancellation and force-stops survivors after one second.
Rust worker pools are limited to two threads; captured service logs stop at
10 MiB. These are development guardrails, not an OS sandbox or deployment limits.
Windows receives process-tree cleanup, but does not currently have the RSS/process
watchdog; use the supported macOS/Linux environment for bounded verification.

Unit tests use at most two workers. Docker verification uses a disposable
BuildKit builder capped at two CPUs and 3 GiB; runtime probes use one GiB.
Browser servers use a fresh `.next/e2e` build directory for each invocation,
isolating signed-out and local identity manifests from the normal development cache.

Run Docker builds and browser acceptance **sequentially**. A failed resource
check is a reason to inspect the log, not to retry without the supervisor.
