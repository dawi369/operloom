# Unattended Operations

Document status: current read-only Level 3 operator runbook and hosted evidence
gate. This runbook does not authorize external mutation.

## Enablement Preconditions

Do not enable a schedule, monitor, or webhook for unattended hosted work until
all of these are true for the same commit:

- `pnpm conformance:level2`, `pnpm conformance:level3`, and
  `pnpm release:check` pass.
- The hosted Worker cron has produced a completed dispatch and the signed
  webhook path has rejected a duplicate without creating a second run.
- `WORKBENCH_OPERATOR_ALERT_WEBHOOK_URL` and its signing secret are configured,
  the receiver verifies signatures and deduplicates alert ids, and one test
  alert has been observed and resolved.
- A hosted D1 export exists with checksum and operator evidence. If R2 is
  enabled, its restore path has also been drilled.
- The trigger is disabled by default, its concurrency limit is reviewed, and
  its workflow/tools remain read-only.

Run `pnpm acceptance:hosted:level3:preflight` before any hosted mutation. It
checks the immutable commit state, pending D1 migrations, R2 account/bucket,
Worker alert configuration, and Vercel receiver configuration without printing
secret values or changing infrastructure. Its ignored report is written under
`output/release/<commit>/level3-hosted-preflight.json`; a nonzero exit means the
rollout must not start.

After the preflight passes, the guarded operator drill command exercises the
negative paths against a unique non-customer WorkOS-shaped tenant:

```bash
WORKBENCH_HOSTED_DRILL_MODE=true \
GITHUB_SHA="$(git rev-parse HEAD)" \
HOSTED_WEB_ORIGIN=https://<web-host> \
HOSTED_FLY_APP=<fly-app> \
CLOUDFLARE_CONTROL_PLANE_URL=https://<worker-host> \
CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET=<current-facade-secret> \
pnpm acceptance:hosted:level3
```

The command proves signed webhook deduplication, one-run concurrency saturation,
cold-start cancellation with no late artifact promotion, cancelled-run replay
lineage, expired-lease recovery, durable alert creation, and failed-lease
replay. It writes mode-`0600` evidence to
`output/release/<commit>/hosted-level3-drills.json`. It stops the current Fly
machine to create a deterministic cancellation window; Fly autostart restores
the machine on the signed runner request. Lease-expiry scaffolding is inserted
directly into the command's isolated D1 tenant and is identified as synthetic
in the report. Never point this command at a customer tenant.

The initial recovery targets are an RPO of 24 hours and an RTO of 4 hours.
These are release targets, not achieved SLOs, until a hosted restore drill
records measured results below both limits.

Use the first-party Vercel receiver unless an operator deliberately chooses a
different incident system:

```txt
WORKBENCH_OPERATOR_ALERT_WEBHOOK_URL=https://<vercel-host>/api/workbench/operator-alerts/ingest
WORKBENCH_OPERATOR_ALERT_SIGNING_SECRET=<same random value in Worker and Vercel>
```

The receiver verifies the signed fresh payload and emits a redacted Sentry
event fingerprinted by alert id. D1 remains canonical for acknowledgement,
resolution, tenant scope, and replay evidence.

## Normal Checks

- `GET /health/live` proves only that the Worker process responds.
- `GET /health` proves required Durable Object bindings and a minimal D1 query.
- `GET /admin/operator-alerts?limit=100` lists scoped durable incidents for an
  owner/admin.
- `GET /trigger-dispatches?limit=100` exposes attempt, lease, run, replay, and
  terminal status.
- History remains the canonical run/artifact recovery surface; control-plane
  events are convergence hints, not truth.

For each enabled trigger, watch completion latency, active lease age, failure
rate, replay count, alert delivery status, and callback rejection. Record the
commit, trigger/dispatch/run/artifact/alert ids, timestamps, logs, and operator
under ignored `output/release/<commit>/` evidence.

## Failure Recovery

1. If a dispatch lease expires, the recovery tick atomically fails the active
   dispatch/run/intent and creates audit, event, and critical alert evidence.
2. Inspect the dispatch and run before replay. Fix missing callback, runner,
   tool policy, or provider availability first.
3. Replay only failed or cancelled dispatches through the existing scoped
   replay route. Replay creates a new run and preserves previous-run lineage.
4. If alert delivery reaches five failed attempts, repair the receiver and call
   `POST /admin/operator-alerts/:id/retry-delivery`. This requeues delivery with
   audited compare-and-set state; it cannot reopen a resolved alert.
5. Acknowledge while investigating; resolve only after a newer successful run
   or explicit operator verification proves recovery.

Cancellation revokes publication authority immediately. The executor may still
finish physically, but a late callback must receive `409 run_terminal` and must
not publish artifacts or successful terminal events.

## Soak Evidence

Before calling Level 3 production-unattended, run at least 24 hours with one
read-only schedule and one signed webhook in a non-customer workspace. Exercise
duplicate delivery, concurrency saturation, cancellation during delayed work,
forced lease expiry, operator replay, alert receiver outage, alert redelivery,
and Worker restart. Acceptance requires:

- no duplicate canonical runs for one idempotency key;
- no late result promotion after cancellation;
- no dispatch stuck beyond its lease plus two scheduler intervals;
- every terminal failure has an open/acknowledged/resolved durable alert;
- receiver outage is visible, capped at five automatic attempts, and recoverable;
- replay lineage and artifact ownership remain tenant-scoped;
- backup/restore measurements meet the candidate RPO/RTO.

Hosted evidence remains manual because it requires real WorkOS, Cloudflare Cron,
R2, alert-receiver, and operator sessions. A local conformance pass must not be
substituted for this soak. The guarded drill command supplies repeatable
negative-path evidence, but it does not replace the 24-hour elapsed-time
schedule/webhook observation or the separate receiver-outage and restore
records.

## Escalation And Kill Procedure

Pause the affected trigger first. If scope is uncertain, pause every trigger for
the affected agent. Revoke runner/callback secrets when signature misuse is
suspected, preserve D1/R2 evidence, and avoid destructive resets. Use forward
fixes for schema incidents. Restore only into a fresh recovery database and make
cutover a separate reviewed decision.

Swordfish remains parked and is excluded from enablement and soak evidence.
