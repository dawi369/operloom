# Operloom mobile

A thin Expo shell over `@operloom/client` and `@operloom/react`. It talks only to
the Worker's `/v1/me` API; nothing goes through the Next.js console.

```bash
cp apps/mobile/.env.example apps/mobile/.env
pnpm --filter @operloom/mobile start      # Expo dev server
pnpm --filter @operloom/mobile check      # tsc + expo config
pnpm exec vitest run apps/mobile          # pure TypeScript unit tests
```

- Sign-in is WorkOS AuthKit PKCE in the system browser; the Worker must list the
  client id in `OPERLOOM_WORKOS_ALLOWED_CLIENT_IDS`.
- Tabs: chat (fetch transport, polling plus the session SSE stream), approvals
  (approve/deny pending tool calls), workspace (switch workspace and agent, sign out).
- Tool results render through a generic fallback; packs can register data-only
  renderers for a richer view (see `docs/agent-packs.md`, Renderers).
