# Operloom Agent Instructions

This repo is a reusable agent workbench built from the assistant-ui LangGraph starter. Treat it as production-oriented application code, not a demo.

## Work Style

- Read the repo first: package manager, scripts, env files, LangGraph config, and surrounding UI components.
- Prefer the smallest correct change that fits the current architecture.
- Use `docs/README.md` as the docs map. Product direction belongs in
  `docs/agent-workbench.md`, the roadmap belongs in
  `docs/implementation-roadmap.md`, and reference app pressure belongs in
  `docs/reference-apps/*`.
- Keep provider secrets server-side. Never add model provider keys to `NEXT_PUBLIC_*`.
- Use pnpm for dependency commands; this repo tracks `pnpm-lock.yaml`.
- Avoid unrelated refactors, formatting churn, and new dependencies unless the existing stack cannot solve the problem.
- When implementation choices are non-obvious, check official docs or primary sources before changing architecture.

## Architecture Defaults

- `app/assistant.tsx` is the frontend runtime integration seam.
- `components/assistant-ui/*` should stay reusable and mostly product-agnostic.
- `backend/agent.ts` is the LangGraph graph/provider seam.
- `app/api/[..._path]/route.ts` proxies browser requests to the LangGraph API.
- `app/api/external-signals/[publicId]/route.ts` is the signed facade for per-trigger Agent Pack webhooks; the unscoped legacy route is retired.
- Cloudflare owns normal chat, authorization, durable run/control state, policy, and audit.
- Use the signed Node.js runner for process/heavy tools; use LangGraph only for delegated graph orchestration. Read `docs/architecture.md` before moving ownership across these boundaries.
- Native clients are WIP on `codex/mobile-wip`; main targets the web workbench and shared client contracts.
- Preserve existing signed header and provider resource identities during branding changes; see `docs/operloom-release.md`.

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

## Safety Rules

- Do not run destructive Git commands unless explicitly requested.
- Do not echo secrets into logs, docs, commits, or chat.
- Before adding persistence, volumes, queues, or new service dependencies, document why the existing Cloudflare and LangGraph primitives are insufficient.
