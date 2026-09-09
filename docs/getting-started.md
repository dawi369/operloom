# Getting started

Start with the [README setup](../README.md#run-it-locally). Use Node.js 24 LTS,
pnpm 10.33.0, an OpenRouter key, and `rg` (ripgrep). Allow about 10 GiB of free
RAM for the full stack and browser. No hosted accounts are required locally.

## Initialize and run

From your checkout:

```bash
pnpm install --frozen-lockfile
pnpm operloom init
```

The initializer creates `.env.local` and `cloudflare/control-plane/.dev.vars`,
generates matching transport secrets, and migrates local D1. It preserves
existing values and data. Set `OPENROUTER_API_KEY` in both files; neither belongs
in Git or a `NEXT_PUBLIC_*` variable.

```bash
pnpm operloom doctor --offline
pnpm operloom dev
```

Open [localhost:3000](http://localhost:3000) and send Operloom a message.
The supervisor starts the web, Worker, runner, and LangGraph services together.
Stop it with Ctrl-C. Use `pnpm operloom doctor` to check running services.

## Run a repository report

In the chat composer, type `/admin`, then choose **Agents** →
**Repository Analyst** → **Use agent**. Select **Assess release readiness**,
review the inputs, and run it. History opens with the report when it completes.
These slash commands open workbench panels; they are not website URLs.

The runner inspects its configured repository, not arbitrary files on your
computer. The report inventories evidence; it does not certify deployment health.

Next, [build your first agent](first-agent.md).

## Troubleshooting

- **Chat fails:** check the OpenRouter key in both generated files, then restart.
  A provider 401 indicates rejected credentials, not poor Wi-Fi.
- **Tools do not run:** use `pnpm operloom dev`; Next.js alone is insufficient.
- **A port is occupied:** stop the previous development instance before restarting.
- **A workflow fails:** keep the dialog open, follow its failed-run link, and
  review History before retrying. Inputs remain available.
- **An old configuration is rejected:** rerun `pnpm operloom init` to update it.

See [service checks and resource limits](dev-infrastructure-readiness.md),
[execution deadlines](runtime-deadlines.md), or [hosted sign-in](tenancy.md).
Do not rebuild a retained database to troubleshoot it.
