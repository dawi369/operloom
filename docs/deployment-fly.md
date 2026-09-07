# Fly.io Acceptance And Production Deployment

Fly is the hosted dev/staging execution runtime. Local development remains the
primary coding loop. Vercel owns the hosted frontend; Fly owns LangGraph and
signed executor work.

## Shape

Each hosted target has its own app and public gateway, declared in
`config/environments/<target>.json`. `fly.langgraph.toml` is local-only.

- Acceptance app: `assistant-mk1-acceptance-runner`
- Production app: `assistant-mk1-production-runner`
- Gateway on `PORT`, default `3000`
- LangGraph dev server on `LANGGRAPH_PORT`, default `2024`
- Gateway proxies LangGraph traffic to `LANGGRAPH_UPSTREAM_URL`
- Gateway serves signed workbench executor requests

This split removes the old Vercel -> Fly Next proxy -> LangGraph hop. Normal
hosted chat now runs through Cloudflare Agents. The Fly gateway remains for
LangGraph compatibility paths, explicit workflow escalation, and signed tool
runner work.

## Required Secrets

Set secrets with `fly secrets set`; do not commit them.

For the dedicated LangGraph runtime, set:

```bash
fly secrets set --app <target-app> OPENROUTER_API_KEY=...
fly secrets set --app <target-app> WORKBENCH_RUNNER_SIGNING_SECRET=...
fly secrets set --app <target-app> WORKBENCH_CALLBACK_SIGNING_SECRET=...
fly secrets set --app <target-app> LANGGRAPH_PROXY_TOKEN=...
```

Optional:

```bash
fly secrets set LANGSMITH_API_KEY=...
fly secrets set LANGSMITH_TRACING=true
fly secrets set --app <target-app> LANGSMITH_PROJECT=operloom-<target>
```

## First Deploy

```bash
fly apps create assistant-mk1-acceptance-runner --region fra
pnpm environment:check --target acceptance
pnpm deploy:fly -- --target acceptance
```

If a planned app name is unavailable, change only the target manifest and
re-run cross-target validation before provisioning.

## Smoke Checks

Health:

```bash
curl <target-fly-origin>/health
```

LangGraph gateway:

```bash
LANGGRAPH_RUNTIME_BASE_URL=<target-fly-origin> \
LANGGRAPH_PROXY_TOKEN=<token> \
pnpm smoke:langgraph-runtime
```

Cloudflare-to-Fly and chat/session boundaries are exercised with signed facade
requests by `pnpm acceptance:hosted:level3`. Hosted dev-token smokes are
rejected.

Public hosted boundary agreement:

```bash
HOSTED_VERCEL_ORIGIN=<vercel-url> \
HOSTED_CLOUDFLARE_ORIGIN=<worker-url> \
HOSTED_FLY_ORIGIN=<fly-url> \
pnpm acceptance:hosted:public
```

The signed-in acceptance journey must then activate Repository Analyst and
complete a readiness workflow through this production-shaped path:

```text
remote Cloudflare Worker -> remote D1
                         -> signed Fly runtime executor
                         -> Worker callbacks -> remote D1 snapshot
```

Tool runner transport:

```bash
LANGGRAPH_RUNTIME_BASE_URL=<target-fly-origin> \
WORKBENCH_RUNNER_SIGNING_SECRET=<runner-secret> \
pnpm smoke:fly-tool-runner
```

When validating callback-backed runner behavior against a reachable callback
receiver, also set `WORKBENCH_RUNNER_CALLBACK_URL`.

Cloudflare uses this path only when the Worker is configured with
`WORKBENCH_RUNNER_TRANSPORT=fly`, `WORKBENCH_RUNNER_URL`, and the matching
`WORKBENCH_RUNNER_SIGNING_SECRET`. Without those settings, Fly-only tools such
as `url.inspect` are unavailable; they never fall back to Cloudflare egress.

Fly machine health uses `GET /health/live`, a shallow gateway liveness check
that does not call LangGraph. Use `GET /health` for deep manual or smoke checks
that should prove the gateway can reach the LangGraph `/ok` endpoint. A healthy
steady-state Fly log should show startup plus Fly health state changes, not
recurring LangGraph `/ok` lines every 15 seconds from machine checks.

Hosted Fly targets keep `min_machines_running = 0`, with automatic stop and
start enabled. Idle Machines therefore release CPU and RAM and cold-start only
when explicit LangGraph or runner traffic arrives. Do not raise the minimum
without an approved latency-versus-cost decision.

The Fly image installs the root production dependency set and boots the checked
in LangGraph CLI/graph pair. Dependency updates must pass
`pnpm verify:security`, the LangGraph runtime boot smoke, and
`pnpm verify:docker`; do not update the CLI independently of that evidence.

Hosted Vercel workbench routes require a signed-in WorkOS browser session.
`pnpm conformance:level2` remains the deterministic local same-origin proof;
the hosted workflow journey is recorded manually against a signed-in session.

Scoped remote D1 reads/writes and cross-tenant `404` behavior are covered by
the signed hosted Level 3, data-lifecycle, and mutation gates.

Cloudflare target deploy sequence:

```bash
pnpm environment:provision -- --target acceptance --provider cloudflare
pnpm environment:check --target acceptance
pnpm db:cloudflare:backup -- --target acceptance
pnpm db:cloudflare:migrate -- --target acceptance
pnpm deploy:cloudflare -- --target acceptance
pnpm acceptance:hosted:level3:preflight
pnpm acceptance:hosted:public
```

Only run `d1 create` during the separately approved provisioning phase. Store
its returned ID in the target environment variable; never copy it into the
local Wrangler config. Hosted reset/rebuild commands are intentionally absent.

Frontend:

- Open the Vercel URL.
- Activate Repository Analyst, run **Readiness report**, and confirm History
  shows the completed run, runner tool call, readiness artifact, policy
  decision, and audit timeline.
- Send a message.
- Confirm a thread is created and streaming works.
- Confirm server logs do not expose provider secrets.

## Health Checks

`fly.langgraph.toml` checks `/health/live`. That endpoint confirms the runtime
gateway is up without calling LangGraph or the model provider.

## Persistence Warning

This first Fly setup does not mount volumes. Do not rely on local filesystem state for important work. Before production use, verify LangGraph persistence behavior across Machine restarts and choose durable persistence intentionally.
