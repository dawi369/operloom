# Scale-to-zero public demo

`demo` is the maintained public deployment profile for `operloom.t23.dev`.
It deploys the same accepted commit as `main`; it is an environment policy, not
a branch or a fork of product behavior. Cold starts are expected.

## Isolated stack

| Layer         | Demo resource                                                             | Idle behavior                                                       |
| ------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Web           | Railway project/service in the T23 workspace                              | Serverless sleep; no volume, worker, replica pool, or heartbeat     |
| Control plane | `operloom-demo-control-plane` Worker                                      | Request-driven; one daily bounded retention sweep                   |
| Data          | D1 `operloom_demo`, R2 `operloom-demo-artifacts`, dedicated DO namespaces | Retained storage only                                               |
| Heavy tools   | Fly `operloom-demo-runner`                                                | One Machine, autostop `stop`, autostart on, minimum zero, no volume |
| Identity      | Separate WorkOS AuthKit application                                       | Standard AuthKit only; no SSO connection or custom auth domain      |
| Models        | Separate OpenRouter key                                                   | Monthly provider limit exactly $20; application fails closed        |
| Errors        | Sentry environment `demo`                                                 | Errors only; tracing and replay disabled                            |

Sleeping compute is not a zero-bill guarantee. Existing provider subscriptions,
retained D1/R2/DO data, Fly root filesystem storage, egress, and requests may be
chargeable. The demo must not create a Railway workspace hard stop that could
affect `t23.dev`.

## Enforced public policy

Cloudflare is the policy boundary. The checked-in profile fails closed unless
all of these values remain exact:

- packs: Operloom, Repository Analyst, and read-only Polymancer Research;
- per user: 20 chat turns/day, 3 workflow runs/day, one active run;
- artifacts: 5 MiB/item and 20 MiB/workspace;
- retention: seven days for demo chat, runs, artifacts, traces, events, and audit data;
- model spend: a demo-only OpenRouter key with a monthly $20 limit.

Credential connections, mutations, approvals, schedules, monitors, webhooks,
push, user-created packs, direct artifact uploads, and administrative mutations
are rejected server-side. Quota rejection is `429`; global model-budget failure
is `503`. Landing, authentication, health, and retained history remain readable.
Crossed 50%, 75%, and 90% model thresholds are recorded once per month and
emitted to provider logs.

## Deployment order

1. Run `pnpm verify`, `pnpm build`, and `pnpm verify:docker` sequentially.
2. Provision isolated Cloudflare, Fly, Railway, WorkOS, and OpenRouter resources.
3. Configure demo secrets and render `config/environments/demo.json`.
4. Back up D1, apply forward migrations, then deploy Cloudflare, Fly, and web from one immutable commit.
5. Smoke every private health boundary before attaching `operloom.t23.dev`.
6. Verify sign-in/callback/logout, chat streaming, all three packs, every denied capability, quotas, budget exhaustion, and seven-day cleanup.
7. Observe for seven days. Accept only when Railway web compute and Fly running compute both reach zero while idle.
8. After acceptance, remove all Operloom Vercel projects, aliases, secrets, and local linkage. Retire old backend resources only after retained-state review.

Use `pnpm deploy:web -- --target demo` for the maintained web target. Vercel
remains an optional adopter path documented in `deployment-vercel.md`; it is not
part of the public demo.
