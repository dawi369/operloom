# Development and infrastructure checks

For setup, use [Getting started](getting-started.md). This page covers service
checks and the safeguards used by the supported development commands.

## Local services

| Service             | Port | Responsibility                                       |
| ------------------- | ---- | ---------------------------------------------------- |
| Next.js             | 3000 | Web workbench and same-origin facade                 |
| Cloudflare emulator | 8787 | Chat, authorization, durable state, and coordination |
| Node.js runner      | 3101 | Signed heavy-tool execution                          |
| LangGraph           | 2024 | Delegated graph workflows                            |

Start the complete stack with `pnpm operloom dev`, then run
`pnpm operloom doctor`. Inspect the reported service logs when a check fails;
stop the previous supervised process before starting another.

Without WorkOS credentials, explicit local identity owns the development
workspace. Configured WorkOS credentials take precedence. Hosted environments
reject the local fallback. See [tenancy](tenancy.md) for the identity boundary.

## Hosted checks

Use your target's `config/environments/*.json` and the
[deployment runbook](environment-separation.md) as the source for resource
names, secrets, and promotion commands. The small personal deployment follows
[minimal hosted testing](minimal-hosted-testing.md).

Verify that Vercel, Cloudflare, and Fly report the intended commit, then exercise
signed-in chat and a repository workflow. Keep matching facade, runner, and
callback secrets server-side. WorkOS callbacks must match the deployed origin.
Cloudflare owns D1/R2 and authorization; the runner does not receive broad
storage credentials.

Hosted mutation, credential brokerage, and unattended automation remain default
off and require [separate acceptance](advanced-production-acceptance.md).

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
Development manifest assets are published with an atomic rename: concurrent
requests see a complete old or new file while Webpack recompiles routes.
Browser assertions allow 15 seconds for cold route compilation and data loading;
the tests retain separate, tighter checks for immediate composer responsiveness.

Run Docker builds and browser acceptance **sequentially**. A failed resource
check is a reason to inspect the log, not to retry without the supervisor.
