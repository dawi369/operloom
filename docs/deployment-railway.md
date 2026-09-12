# Railway web deployment

Railway is the maintained Next.js host for the `demo` environment and
`operloom.t23.dev`. The provider-neutral `web` manifest keeps Vercel available
for adopters without making it part of Operloom's public demo.

The demo service uses [railway.toml](../railway.toml): one replica, no volume,
`sleepApplication = true`, `/api/health` health checks, and the repository's
pnpm build/start commands. Do not add application heartbeats, periodic outbound
traffic, background workers, or monitors that prevent Serverless sleep.

Required non-secret references are `WORKBENCH_DEMO_RAILWAY_PROJECT_ID`,
`WORKBENCH_DEMO_RAILWAY_ENVIRONMENT_ID`, and
`WORKBENCH_DEMO_RAILWAY_SERVICE_ID`. Configure secrets with
`pnpm environment:configure-secrets -- --target demo`, then deploy the immutable
commit with `pnpm deploy:web -- --target demo` and the guarded `--execute` form
printed by the dry run.

Before DNS cutover, verify `/api/health`, `/api/health/facade`, WorkOS redirects,
and authenticated streaming on the Railway origin. After cutover, leave the
service inactive for at least ten minutes, verify it sleeps in Railway, then
confirm that the first request wakes it successfully.
