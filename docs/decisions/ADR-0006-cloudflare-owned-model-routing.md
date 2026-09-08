# ADR-0006: Cloudflare-Owned Model Routing

Status: accepted as north-star direction

## Context

Operloom now has Cloudflare resolving the signed-in WorkOS account,
workspace, membership, and active agent before normal chat runs. Current simple
chat still uses worker-level provider configuration such as `OPENROUTER_MODEL`.
That is acceptable as a development default, but it is not the right long-term
control model for a reusable workbench sold across organizations and adapted to
different applications.

Model choice, provider access, cost class, and runtime settings will need to
vary by account, workspace, agent, and possibly user. That control must be
server-derived and policy-governed. The browser should not be able to select a
tenant, workspace, agent, provider, or model directly.

## Decision

Cloudflare should become the central model-routing authority.

Environment variables remain bootstrap defaults and emergency fallbacks. They
must not remain the durable source of truth for normal production model
selection.

The north-star resolution order is:

```txt
system default
-> account policy
-> workspace default
-> agent runtime config
-> allowed user preference
```

The resolved runtime config should include provider, model id, model parameters,
budget or cost class, and any policy constraints needed to decide whether the
request can run. Cloudflare-owned simple chat should use this resolver directly.
When work escalates to Fly/LangGraph or another execution backend, Cloudflare
should pass the resolved runtime config to that backend instead of letting the
backend independently choose a global model from its own environment.

The first implementation step should store minimal agent runtime config in
`agents.data_json`, because agents are already workspace-scoped and resolved by
Cloudflare. Later slices can promote model/provider rules into dedicated D1
tables when model policy, budget tracking, provider credentials, and admin UI
need stronger structure.

## Consequences

- Model/provider choice is part of the control plane, not frontend state.
- Workspace and agent configuration can diverge across customer accounts.
- User-level model preferences are only allowed inside account/workspace policy.
- Fly stays closer to stateless execution compute; Cloudflare owns routing,
  policy, and runtime configuration.
- Provider secrets stay server-side and can later be scoped, rotated, audited,
  and budgeted without changing the browser contract.
- The current `OPENROUTER_MODEL` value remains a development default until the
  model resolver exists.
