# Future 1.0.0 Production Readiness

Document status: future public-release contract. Operloom 0.5 implements
the local Operational L3 plus Authority A2 boundaries, but makes no production
SLO or public 1.0 claim. Local conformance does not replace the same-commit
hosted gates below.

## Included

- WorkOS identity, organizations, tenant-scoped workspaces, membership roles,
  agent snapshots, and fresh-auth fencing for workspace deletion.
- Cloudflare-owned chat, typed tools/workflows, durable runs, approvals,
  cancellation, retry, artifacts, policy, audit, triggers, leases, replay, and
  unattended-failure alerts.
- Runtime Module v1 packages with deterministic compilation, compatibility,
  health/eval bindings, generic UI renderers, and no core registration edits.
- Forward-only retained-data migrations, workspace retention confirmation,
  asynchronous complete export, 30-day deletion quarantine/recovery, and
  resumable D1/R2/Durable Object purge.
- Provider-neutral `CredentialVault` with WorkOS Vault production custody,
  API-key and OAuth 2.0 Authorization Code + PKCE brokerage, refresh CAS,
  revocation, health, and permitted-host request capabilities.
- Durable mutation proposals, policy and approval checks, stable idempotency,
  kill switches, append-only action ledger, `outcome_unknown`, reconciliation,
  and History/Admin projections.
- Complex Operator as the deterministic non-financial mutation fixture. Baby
  Polymancer remains read-only and Baby Swordfish remains parked.

## Feature-gate order

All three deployment gates default off:

1. `WORKBENCH_RETAINED_DATA_ENABLED`
2. `WORKBENCH_CONNECTIONS_ENABLED`
3. `WORKBENCH_MUTATIONS_ENABLED`

Enable them in that order for an isolated acceptance workspace. Mutation also
requires retention confirmation, an authorized healthy connection, an
execute-capable compiled binding, clear workspace/pack/tool/connection kill
switches, an allow policy decision, and approval unless an operator explicitly
edits the policy. General workspace mutation remains opt-in.

## Release evidence

| Boundary          | Required evidence                                                                    |
| ----------------- | ------------------------------------------------------------------------------------ |
| Repository        | `pnpm release:check`, clean clone, `git diff --check`                                |
| Environment split | `pnpm verify:environment-config`, protected target preflight                         |
| Hosted drift      | `pnpm acceptance:hosted:configuration`                                               |
| Observability     | `pnpm observability:check`, `pnpm acceptance:hosted:observability`                   |
| Runtime extension | `pnpm conformance:agent-system`                                                      |
| Operational L0–L2 | `pnpm conformance:level2`                                                            |
| Operational L3    | `conformance:level3`, `acceptance:hosted:soak`, `acceptance:hosted:alert-redelivery` |
| Retained data     | `conformance:data-lifecycle`, encrypted backup, hosted export/recovery/purge         |
| Connections       | `pnpm conformance:connections`, `pnpm acceptance:hosted:vault`                       |
| Mutation          | `pnpm conformance:actions`, `pnpm acceptance:hosted:mutation`                        |
| Supply chain      | `pnpm verify:security`, `pnpm verify:docker`                                         |
| Public hosting    | `pnpm acceptance:hosted:public` (includes a live Vercel-to-Cloudflare facade probe)  |
| Signed-in product | WorkOS browser acceptance across Vercel, Cloudflare, and Fly                         |

`pnpm verify:security` blocks high and critical advisories unless an explicit
local remediation is verified. The former Expo exceptions were removed with
the native app; mobile is WIP on `codex/mobile-wip` and is not a web release gate.

Ignored evidence records must name one full commit SHA. Hosted Vault evidence
must prove create/read-version/replace/revoke-delete without disclosing values.
Hosted mutation evidence must name the isolated workspace, run, proposal,
approval, provider reference, connection revocation, and kill-switch/reconcile
drills.

The hosted evidence collector requires ordered same-SHA Cloudflare promotion
records (`disabled` -> `retained-data` -> `connections` -> acceptance-only
`mutations`), an elapsed soak record, and manual signed-in evidence. A passing
short workflow run cannot synthesize either elapsed time or an authenticated
browser observation.

## Final checklist

- [ ] Clean clone installs with `pnpm install --frozen-lockfile`, applies local
      migrations, passes `pnpm workbench doctor`, and reaches usable chat from
      README instructions only.
- [ ] All repository, browser, conformance, Docker, build, formatting,
      dependency-audit, and generated-registry gates are green.
- [ ] Local, acceptance, and production Worker/D1/R2/DO, Fly, Vercel, WorkOS,
      origin, and signing-secret references are distinct; production rejects
      conformance, memory Vault, dev tokens, shared signing secrets, and default
      workspace mutation enablement.
- [ ] New Workers are bootstrapped with public ingress and cron triggers disabled;
      final Cloudflare, Fly, and Vercel deploys require same-commit provider-secret
      evidence.
- [ ] Fresh and prior-baseline databases apply migrations `0006`–`0014`; backup
      restore and forward-fix rehearsal meet recorded RPO/RTO.
- [ ] D1/R2/DO export manifest checksums pass; quarantine recovery and
      time-shifted final purge remove all customer state while retaining only a
      non-identifying receipt.
- [ ] WorkOS Vault create/read/rotate/revoke/delete and OAuth PKCE/refresh/replay
      evidence pass without credentials entering logs, D1, exports, callbacks,
      model context, artifacts, traces, or Fly envelopes.
- [ ] Synthetic mutation proves approval denial and resume, idempotent duplicate
      dispatch, every kill-switch scope, timeout ambiguity, reconciliation,
      cancellation fencing, and cross-tenant `404`.
- [ ] Same-commit 24-hour schedule/webhook soak, receiver-outage redelivery,
      and signed-in operator journeys are recorded.
- [ ] One iOS and one Android internal-preview build pass sign-in, early send,
      foreground resume, workflow/artifact, push, and sign-out revocation with
      symbolicated mobile errors under the same Sentry release SHA.
- [ ] Dashboards and alerts cover lifecycle failures/backlog, Vault and OAuth
      failures, blocked mutation, `outcome_unknown`, trigger failures, and alert
      delivery failures.
- [ ] Credential-class rotation review, security audit, screenshots, changelog,
      evidence matrix, and production runbooks are complete.
- [ ] Retained data, then connections, then mutation are enabled and accepted in
      an isolated non-customer workspace before the `v1.0.0` tag.

## Explicit non-claims

The release does not include real trading, Polymancer mutation, Swordfish
execution, a credential marketplace, remote executable installation,
delegation, legal hold, multi-region failover, or exactly-once provider effects.

Deterministic release screenshots are regenerated with
`pnpm release:screenshots` from synthetic local state and tracked under
`docs/assets/release/`. Hosted rows remain pending until the protected
`Hosted release evidence` workflow produces one full-SHA acceptance manifest
and the elapsed 24-hour evidence described in `environment-separation.md`.
