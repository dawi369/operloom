# Contributing

Operloom is production-oriented application code. Changes should preserve
the Vercel session, Cloudflare control-plane, and Fly execution boundaries while
keeping the reusable assistant-ui layer product-agnostic.

## Development Setup

Requirements:

- Node.js 24 LTS for release parity; Node.js 26 is accepted for local development
- pnpm 10.33.0
- Chromium for the Playwright release suite (`pnpm exec playwright install chromium`)
- a Cloudflare account for remote Worker work
- a WorkOS environment for hosted authentication work

Release evidence is authoritative only on Node 24. Node 26 is supported for
local iteration, but runtime-sensitive failures must be reproduced on Node 24.

```bash
pnpm install --frozen-lockfile
pnpm workbench init
```

The initializer creates only missing local files, fills blank or documented
placeholder development secrets, upgrades the retired inline local-runner
default, and applies forward D1 migrations. It preserves configured credentials
and custom endpoints. Set `OPENROUTER_API_KEY` in both local environment files,
then verify setup:

```bash
pnpm workbench doctor --offline
```

Use `pnpm db:cloudflare:rebuild:local` only for a deliberate destructive reset.

Start the complete workbench:

```bash
pnpm workbench dev
```

The frontend runs at `http://localhost:3000`, LangGraph at
`http://localhost:2024`, the Cloudflare Worker at `http://localhost:8787`, and
the signed runner gateway at `http://localhost:3101`. The supervisor stops the
complete process set when one required service exits.

## Change Workflow

1. Read `docs/README.md` and the current-state document for the affected area.
2. Keep the change inside the existing ownership boundary.
3. Add behavior-focused tests near the changed module.
4. Run `pnpm verify:fast` while iterating.
5. Run `pnpm verify` before opening a pull request.
6. Run `pnpm test:e2e` when the visible workbench, session gate, or recovery flow changes.
7. Run the affected Cloudflare or Fly smoke when behavior crosses a service boundary.

`pnpm test:e2e` rebuilds only its isolated D1 fixture in
`output/playwright/state`; it does not touch the normal local Worker database.
Use `pnpm release:check` for the complete code, build, and browser gate.
Local Markdown and image links are enforced by `pnpm docs:check`, which is also
part of `pnpm verify:fast`.

## Architecture Rules

- Browser code never chooses tenant scope, user IDs, workspace IDs, or secrets.
- Vercel derives WorkOS session identity and signs requests to Cloudflare.
- Cloudflare owns application authorization, durable control state, policy, and audit.
- Fly/LangGraph receives scoped work only through signed server-side contracts.
- `components/assistant-ui/*` remains reusable; product composition belongs in
  `components/workbench/*`.
- Mutation-capable tools remain default-off and require retention confirmation,
  a healthy connection, explicit enablement, policy, approval when required,
  and clear kill switches.

## Pull Request Checklist

- [ ] The behavior change has focused tests.
- [ ] Tenant and role boundaries have negative coverage when durable state changes.
- [ ] Errors returned to users are actionable and redacted.
- [ ] Current-state docs match the implementation.
- [ ] `pnpm verify` passes.
- [ ] `pnpm test:e2e` passes for user-visible or session changes.
- [ ] Relevant local or hosted smoke commands and results are included.

Do not include credentials, `.env.local`, `.dev.vars`, production payloads, or
private tenant data in issues, fixtures, screenshots, or pull requests.
