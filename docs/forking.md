# Forking and Upstream Updates

Document status: current downstream compatibility and update policy.

New users adopt immutable `v1.0.0`, then record its full commit SHA. Historical
`fork-base-v1` and `fork-base-v1.0.1` tags remain compatibility evidence and are
never moved. `fork-base-v1.1.0` is an uncut historical proposal, not an onboarding
requirement. Mobile remains WIP on `codex/mobile-wip`.

Application 1.x promises additive minor releases and corrective patches for the
documented SDK/client interfaces, Pack API v2, and Runtime Module v1. Breaking
changes require explicit migrations and an appropriate major version. Source
merges can still conflict; internal implementation imports are not public APIs.
See the [release contract](release-1.0.md).

## Boundaries

Application-owned code includes the Vercel facade, Cloudflare control plane,
Fly gateway, D1 lifecycle, connection/action authority, session coordination,
and generic workbench UI. A downstream agent should normally change only its
Runtime Module package and the single entry in `workbench.config.ts`.

The extension contract is:

- Pack API v2 immutable manifest snapshots;
- Runtime Module v1 `manifest`, `control-plane`, `runner`, and `web` exports;
- `AgentExecutionContext` rather than raw platform state or credentials;
- compile-time and runtime workbench/pack/runtime compatibility checks;
- generated registries as reviewed build artifacts.

Additive Runtime Module v1 declarations are compatible. Breaking serialized or
source contracts require a new API major. An incompatible historical snapshot
keeps chat access but cannot invoke tools, workflows, triggers, retries, or
actions; runtime resolution fails closed with `workbench_incompatible` or
`runtime_incompatible`.

## Create the downstream repository

Fork or clone the complete repository at `v1.0.0`, then retain the
original repository as a read-only upstream:

```bash
git remote rename origin upstream
git remote add origin <downstream-repository-url>
git fetch --tags upstream
git switch -c operloom-base v1.0.0
git push -u origin operloom-base
```

Record the base tag and commit in downstream release notes. Do not move or
recreate foundation tags.

Configure the fork's public product identity before provider setup:

```bash
pnpm workbench fork init \
  --id my-workbench \
  --name "My Workbench" \
  --origin https://workbench.example.com
pnpm workbench fork --check
```

The command updates the application identity in `config/product.json`. It
retains the stable internal `@operloom/*` namespace and does not invent
provider-owned WorkOS, Sentry, Vercel, Cloudflare, or Fly identifiers. Configure
those through the environment manifests and provider setup commands. Mobile
identity configuration belongs to the separate WIP branch.

A downstream project is not a 1.0 release requirement. Before adapting core code,
try the [first-agent walkthrough](first-agent.md): register a pack through
`workbench.config.ts`, customize its prompt, and run its read-only example.

## Review an upstream update

Never merge upstream automatically. Use one disposable update branch per
candidate merge:

```bash
git fetch upstream --tags
git switch main
git switch -c update/operloom-<date>
git merge --no-commit upstream/main
```

Review SDK contract changes before resolving application conflicts. Refresh a
contract manifest only when the downstream intentionally accepts the public
change and records it in its changelog. Generated registry drift is resolved by
running the compiler, never by hand-editing generated files.

The acceptance command is:

```bash
pnpm fork:check
```

It includes registry and pack validation, SDK hash and zero-context consumer
checks, installed-package extension conformance, runtime architecture tests,
unit/type/lint/security/build checks, Docker containment, Level 2-3, lifecycle,
connection, action, agent-system, and browser journeys. A merge is eligible only
when local evidence and GitHub checks are green for the same commit.

Native delivery is deferred; see [Mobile WIP](mobile-frontends.md).

## Rollback

If an accepted upstream update regresses the downstream product, restore the
previous downstream release from its immutable foundation-derived tag. Do not
rewrite the current tag or force an incompatible SDK manifest. Create a new
fix/update branch and rerun `pnpm fork:check` before advancing production.

Database and hosted infrastructure changes remain separate rollout decisions.
Passing the fork gate does not authorize deployment, migration, credential
rotation, package publication, or feature-gate activation.
