# Operloom 0.5 Foundation Release

Document status: current internal pre-1.0 release candidate contract.

Release state: candidate.

Version `0.5.1` is the current application line and production-hosted candidate.
It carries the stable unpublished Agent SDK `1.0.1`, Pack API v2, Runtime Module
v1, retained-data, connection-brokerage, and policy-controlled action
subsystems. No immutable `v0.5.1` tag or GitHub release has been cut. It does
not make a public-production SLO or real-provider mutation claim.

## Acceptance requirements

- Local `pnpm fork:check`, `pnpm release:check`, accessibility, clean-clone,
  Docker, generated-registry, dependency-audit, and build evidence must be green.
- Vercel, Cloudflare, and Fly must deploy from one full commit SHA and report
  that SHA with application version `0.5.1` from their public health endpoints.
- Production Cloudflare promotion must be recorded in order through `connections`;
  mutation remains globally disabled outside isolated acceptance.
- WorkOS Vault is the production credential backend; conformance mode, memory
  Vault, local-dev identity, shared secrets, and default workspace mutation are
  rejected.
- Global mutation code is available, but every workspace remains disabled by
  default and no shipped production pack exposes an execute-capable mutation.
- Signed-in operator acceptance covers current pack activation, chat, History,
  lifecycle, Connections, and visible mutation-subsystem posture.

The historical immutable tags `v0.5.0`, `fork-base-v1.0.1`, and
`fork-base-v1` remain unchanged. `fork-base-v1.0.1` remains the accepted fork
base. A `v0.5.1` prerelease may be cut only after same-commit hosted evidence is
recorded; `fork-base-v1.1.0` additionally requires accepted iOS and Android
device evidence.

## Deferred to public 1.0

The 24-hour trigger/webhook soak, receiver-outage redelivery, production SLO,
real-provider mutation acceptance, credential-class rotation review, and the
complete same-commit checklist in `release-readiness.md` remain unachieved 1.0
requirements. Trading adapters, delegation, multi-region failover, Polymancer
mutation, and Swordfish execution are not part of 0.5.
