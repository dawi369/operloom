# Fly Runner Deployment

Fly hosts the signed Node.js tool runner (`runner/server.ts`). Cloudflare owns
chat, authorization, state and the user-facing stream; the runner only executes
tools the Worker dispatches to it and reports results back through signed
callbacks. Local development runs the same runner on port 3101
(`pnpm operloom dev`).

## Shape

Each hosted target declares its own Fly app in
`config/environments/<target>.json` (`fly.appName`, `fly.origin`).

- Image: `Dockerfile.runner` (Node 24, production dependencies, `PORT=3000`).
- Config: `fly.runner.toml` (`internal_port = 3000`, `/health/live` checks,
  `auto_stop_machines = "stop"`, `min_machines_running = 0`).
- Invocations: `POST /workbench/tool-runners/invocations`, signed with
  `OPERLOOM_RUNNER_SIGNING_SECRET`.
- Results: signed callbacks (`OPERLOOM_CALLBACK_SIGNING_SECRET`) to the Worker's
  `/workbench/run-callbacks`, accepted only for `OPERLOOM_CALLBACK_ORIGIN`.

The runner holds no durable state and mounts no volume. Do not rely on its
filesystem.

## Secrets

Set secrets with `pnpm environment:configure-secrets -- --target <target>` or
`fly secrets set`; never commit them. The runner needs:

```bash
fly secrets set --app <target-app> OPERLOOM_RUNNER_SIGNING_SECRET=...
fly secrets set --app <target-app> OPERLOOM_CALLBACK_SIGNING_SECRET=...
fly secrets set --app <target-app> OPERLOOM_CALLBACK_ORIGIN=<target-worker-origin>
```

The Worker uses the runner only with `OPERLOOM_RUNNER_TRANSPORT=fly`,
`OPERLOOM_RUNNER_URL` and the matching signing secret. Without them, runner-only
tools such as `url.inspect` are unavailable; they never fall back to Cloudflare
egress.

## Deploy

```bash
fly apps create <target-app> --region fra
pnpm environment:check --target acceptance
pnpm deploy:fly -- --target acceptance
```

Deployment commands are dry runs until `--execute` and the printed confirmation
token are supplied; see [environments](environment-separation.md). The wrapper
creates one Machine per process group (`--ha=false`). Idle Machines stop and
cold-start on the next runner invocation; do not raise the minimum without an
approved latency-versus-cost decision.

## Smoke Checks

```bash
curl <target-fly-origin>/health/live
OPERLOOM_RUNNER_BASE_URL=<target-fly-origin> \
OPERLOOM_RUNNER_SIGNING_SECRET=<runner-secret> \
pnpm smoke:fly-tool-runner
```

Set `OPERLOOM_RUNNER_CALLBACK_URL` as well to exercise callbacks against a
reachable receiver. Check that the Worker, web and runner origins agree:

```bash
HOSTED_WEB_ORIGIN=<web-url> \
HOSTED_CLOUDFLARE_ORIGIN=<worker-url> \
HOSTED_FLY_ORIGIN=<fly-url> \
pnpm acceptance:hosted:public
```

Image changes must pass `pnpm verify:security` and `pnpm verify:docker`, which
builds the image and checks signed-runner readiness in a container.
