# Operloom Agent Instructions

This repo is a reusable agent workbench. Treat it as production-oriented application code, not a demo.

## Work Style

- Read the repo first: package manager, scripts, env files, Worker/runner config, and surrounding UI components.
- Prefer the smallest correct change that fits the current architecture.
- Use `docs/README.md` as the docs map. `CHANGELOG.md` records what is verified.
- There are no production users yet; breaking changes are acceptable when they simplify the platform.
- Keep provider secrets server-side. Never add model provider keys to `NEXT_PUBLIC_*`.
- Use pnpm for dependency commands; this repo tracks `pnpm-lock.yaml`.
- Avoid unrelated refactors, formatting churn, and new dependencies unless the existing stack cannot solve the problem.
- When implementation choices are non-obvious, check official docs or primary sources before changing architecture.

## Architecture Defaults

- `app/assistant.tsx` is the frontend runtime integration seam.
- `components/assistant-ui/*` should stay reusable and mostly product-agnostic.
- `app/api/external-signals/[publicId]/route.ts` forwards per-trigger webhooks; the Worker verifies each trigger secret.
- The Worker serves only `/v1` to the network. The web console is a `/v1` client (`/v1/me`) using the signed-in WorkOS access token; never add identity headers or facade routes.
- Cloudflare owns normal chat, authorization, durable run/control state, policy, and audit.
- Use the signed Node.js runner (`runner/server.ts`) for process/heavy tools. Read `docs/architecture.md` before moving ownership across these boundaries.
- Native clients are WIP on `codex/mobile-wip`; main targets the web console and shared client contracts.
- Product-specific code belongs in forks (see `docs/forking.md`); keep main product-neutral.

## Local resource safety

- Run browser acceptance and Docker builds sequentially, never together.
- Use the supervised development commands; they enforce process-group cleanup and resource budgets on macOS/Linux.
- Development uses Webpack. Reproduce bundler changes only under the supervisor; never retry unbounded Turbopack workers.

## Verification

Run the narrowest useful checks after each change:

```bash
pnpm typecheck
pnpm build
pnpm lint
```

For runtime work, also smoke:

```bash
pnpm operloom dev
curl http://localhost:3000/api/health
```

For Fly staging work, deploy only after local checks pass and then smoke the hosted `/api/health`, assistant thread creation, streaming, and any external-signal route touched by the change.

During development, local checks are the gate. Push once they pass and keep working; do not wait on or poll GitHub Actions. Look at CI only when it reports a failure or before a release.

## Safety Rules

- Do not run destructive Git commands unless explicitly requested.
- Do not echo secrets into logs, docs, commits, or chat.
- Before adding persistence, volumes, queues, or new service dependencies, document why the existing Cloudflare and runner primitives are insufficient.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
