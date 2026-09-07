# Minimal hosted testing

This is my small, authenticated Operloom installation for occasional manual
checks. Local development and CI do the broad verification. It is not an
always-on production service or a public anonymous demo.

## Active stack

| Layer              | Resource                                            | Idle behavior                                                |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------------ |
| Web                | `operloom` on Vercel; `https://operloom.vercel.app` | Request-driven                                               |
| Control plane      | `operloom-control-plane` on Cloudflare Workers      | No cron schedules                                            |
| Data               | D1 `operloom`, R2 `operloom-artifacts`              | Retained storage; request-driven operations                  |
| Chat/session state | Existing Durable Object namespaces                  | Preserved across Worker rename                               |
| Heavy tools        | Fly `operloom-runner`, Frankfurt                    | One shared CPU, 1 GB RAM; automatic stop/start, minimum zero |
| Notifications      | `operloom-control-plane-notifications`              | Delivery paused; push disabled                               |

The signed runner contract protects tenant headers and carries an explicit network
policy to network-aware tools, including redirect hops for URL inspection. Agent
packs are trusted code; this is not isolation for arbitrary untrusted plugins.

Mutations and conformance mode remain disabled. Authenticated chat and explicit
runner tools remain available. Scheduled agents and queued notifications are
not part of this testing profile. Cold starts are expected. Stopped Machines
and retained storage are not a promise of a zero bill; provider subscriptions,
root filesystems, storage, egress, and model usage can still be chargeable.

The `production` target manifest describes the active resource names; the target
name selects isolation and authorization rules, not a claim of production
readiness. A separate `acceptance` manifest is available for forks that need it,
but no second personal stack needs to run continuously. Fly deploys explicitly
use `--ha=false`; increasing availability is a deliberate cost decision.

## Migration and rollback

The September 2026 rename preserved the Worker and both Durable Object IDs.
The D1 contents and migration ledger were copied to the new database and checked
against the source. The source R2 bucket was empty. Signed transport headers
remain compatible; changing visible names does not require rotating credentials.

Historical Vercel projects are renamed with an `-archive` suffix and paused.
The old dev/acceptance Workers have no public or preview endpoints. The three
old Fly apps are scaled to zero Machines; app secrets and saved image/config
references remain available for rollback. Historical
D1 databases and R2 buckets retain their names as rollback copies. Do not point
new deployments at those copies or delete retained data casually.

Private migration backups and provider snapshots live under the ignored
`output/operloom-deployment/` directory. They contain sensitive data and are not
release artifacts or material to upload to an issue.

## Remaining provider identity cutover

The WorkOS dashboard must accept `https://operloom.vercel.app/auth/callback`
before changing `NEXT_PUBLIC_WORKOS_REDIRECT_URI`. Until that is verified, the
old `assistant-mk1.vercel.app` alias and callback remain in place to preserve
login. Signing in can return to that compatibility origin. WorkOS display
branding and the Sentry project slug require dashboard access; the existing
Sentry DSN stays attached to its original project.

After the callback is accepted, set the frontend redirect, deploy, and verify
sign-in, thread creation, and a streaming response before retiring the old
alias. Do not infer signed-in acceptance from public health checks.

## Verification

Check web `/api/health`, web `/api/health/facade`, Worker `/health/live` and
`/health`, and runner `/health/live` and `/health`. The signed facade health
endpoint checks the shared secret and release identity across services. An
unauthenticated `/api/workbench/context` must return `401`.

For CLI deployments, provide `WORKBENCH_RELEASE_SHA` explicitly. A blank
`VERCEL_GIT_COMMIT_SHA` must not mask it. Deploy a clean source export to avoid
uploading local caches or secrets; builds run on the providers. After testing,
verify that the runner has stopped and that schedules remain empty.
