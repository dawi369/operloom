# Secrets And Risk

Operloom must assume tools can be powerful. Secret custody and execution policy are framework primitives, not app-specific extras.

## Secret Custody

Secrets must be:

- Encrypted at rest.
- Scoped by `userId` and `workspaceId`.
- Revocable.
- Server-side only.
- Available only to approved tools.
- Never returned to browser API responses.
- Redacted from logs, artifacts, traces, and model-visible content unless explicitly safe.

Secrets include model keys, account keys, API tokens, webhook signing keys, OAuth refresh tokens, and any credential that can spend money, move assets, mutate production systems, or access private data.

Connection auth brokering is operational. Pack API v2 declares provider,
principal, credential class, scopes, tool bindings, and external-broker custody.
Tool summaries and capability decisions expose only the compact
`connectionAuth` posture: whether authorization is required, which principal
owns it, whether refresh is brokered, how tool filters apply, and whether
connection authorization precedes policy approval. Public tools report
`not_required`; credentialed declarations report `authorization_required`,
`authorized`, `refresh_required`, or `unhealthy`. WorkOS Vault is the production
credential store; D1 retains opaque references and metadata only. OAuth uses
Authorization Code + PKCE with hashed single-use state and refresh CAS. API keys
travel through the signed Vercel facade directly to the broker. Brokered
requests enforce declared provider hosts and never expose the credential to the
pack, browser response, Fly envelope, callback, artifact, trace, export, or
model context.

## Execution Modes

Early contracts should avoid hardcoded risk taxonomies. The first deterministic control is execution mode:

- `ask`: the agent can reason, explain, and propose, but cannot mutate external state.
- `dry_run`: the agent or tool can simulate effects and return proposed actions.
- `execute`: the tool may mutate external state only if policy allows it.

Risk scoring, approval rules, limits, and kill switches belong in policy configuration around these modes, not in early framework contracts.

## Required Controls

Tools that can mutate external state must support:

- Dry-run mode.
- Approval gates.
- Per-user and per-workspace limits.
- Allowlists and denylists.
- Cooldowns and rate limits.
- Kill switches.
- Immutable audit events.
- Structured failure reporting.

## Production Bar

Live external mutation is blocked until auth, encrypted secrets, tenant isolation, ledgers, auditability, permissions, policy limits, and kill switches exist.

This applies to any mutation-capable tool, including market execution, deployment, database mutation, billing, email sending, and production admin actions.
