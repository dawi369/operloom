# Tenancy And Isolation

Multi-user support is a foundation, not an add-on. Every durable object in operloom must be scoped by both `userId` and `workspaceId`.

## Tenant Scope

`TenantScope` is:

```ts
{
  userId: string;
  workspaceId: string;
}
```

This scope applies to:

- Threads and runs.
- Tool permissions and tool calls.
- Secrets and credential references.
- Memory, notes, personality, and decision records.
- Ledgers, managed state, and audit events.
- Triggers, schedules, webhooks, and heartbeats.
- Artifacts, logs, reports, and traces.
- Workflow intents and workflow state.

## Identity, Workspace, And Agent Model

Operloom is meant to serve many customer environments and many internal
use cases without confusing product organization with tenant identity.

- WorkOS User: the authenticated person. WorkOS owns sign-in, sessions, and
  enterprise identity features such as SSO or directory sync when they are
  added.
- WorkOS Organization: the customer or company account source in a B2B
  deployment. It maps to an operloom account id, not directly to a
  workspace id.
- Operloom Workspace: the internal tenant boundary used by Cloudflare and
  D1. The current baseline creates one default workspace per WorkOS
  organization or personal account source, and workspace management v0 allows
  additional workspaces to be created and activated from Admin.
  Membership, policy, secrets, tool permissions, agents, audit records, and
  durable state are scoped here.
- Agent: a runtime assistant/configuration inside a workspace. A workspace can
  have multiple agents with different tools, policies, knowledge, and operating
  modes.

For a business customer, the current hosted mapping is:

```txt
WorkOS organization -> operloom account -> active workspace -> agents
```

The default workspace id is stable:

```txt
WorkOS organization -> workos-org:<organizationId> -> workspace:workos-org:<organizationId>:default
```

Cloudflare stores the current user's active workspace preference for the
account. If no preference exists, Cloudflare falls back to the default
workspace. The WorkOS organization remains the account source and each
operloom workspace is an operational boundary under that account.

For current solo/pre-user development, a signed-in WorkOS user without an
organization gets a stable personal account id:

```txt
workos-personal:<workos-user-id>
```

That fallback keeps the production-shaped Cloudflare authz path working during
development and can support a future solo tier. It is not the B2B tenant model.

There is no committed Project entity in the current architecture. Workspace and
agent are the committed authorization boundaries.

## Hard Rules

- The model never chooses tenant scope.
- Scope is derived from authenticated request/session context or trusted system trigger metadata.
- Queries must include tenant scope at the storage/access layer, not only in prompts.
- Tool execution receives scope from the runtime and cannot override it.
- Secret lookup requires tenant scope plus tool permission.
- Cross-workspace sharing is denied by default and must be designed as an explicit future capability.
- Browser code never chooses `userId`, `workspaceId`, or `agentId`; it can only
  ask the server for the current resolved context.
- WorkOS owns authentication and organization membership signals. Cloudflare
  owns application authorization, internal workspace materialization, D1
  membership role/status, agent records, tool access, secret policy, run
  control, and audit.

## Current Implementation Status

- Hosted Vercel uses WorkOS AuthKit as the sign-in boundary.
- Vercel maps WorkOS `user.id` to internal `userId`.
- Vercel maps WorkOS `organizationId` to an internal account id when present.
- During pre-user development, signed-in WorkOS sessions without an
  organization fall back to a stable `workos-personal:<user-id>` account and
  default workspace.
- Vercel forwards trusted user/account headers to the Cloudflare Worker;
  browser requests never provide tenant ids directly.
- Cloudflare auto-bootstraps D1-backed user, default workspace, active
  membership, and default agent rows for the current pre-user dev environment.
- Cloudflare stores the active workspace preference per `user_id + account_id`.
  Hosted WorkOS traffic resolves the active workspace inside Cloudflare and
  falls back to the default workspace when no preference exists.
- Cloudflare D1 is authoritative for app membership once a membership row
  exists. WorkOS role and permission metadata can seed a missing membership and
  appear as external identity signals, but request headers do not overwrite
  existing D1 membership role, status, roles, or permissions.
- Cloudflare stores active agent preferences per `user_id + workspace_id`.
  Hosted WorkOS traffic resolves the active agent inside Cloudflare, falling
  back to the workspace default agent when no preference exists, instead of
  forwarding `WORKBENCH_DEV_AGENT_ID`.
- The signed-in Workspace panel lists the user's active WorkOS organization
  memberships through a server-only WorkOS API call and switches organization
  context with AuthKit session refresh. Organization IDs never become trusted
  browser tenant scope.
- Active members may switch among operloom workspaces where they have an
  active membership. Owners/admins may create workspaces and manage members;
  admins can only manage the `member` role, self-lockout is blocked, and the
  final active owner cannot be removed.
- A user can be added to a non-default workspace only after Cloudflare verifies
  an active membership in the same account's default workspace. Arbitrary or
  cross-account user IDs are rejected.
- Agent records are workspace-scoped Cloudflare D1 rows. Admin may create
  test agents, show profiles, and activate existing agents for the current
  operator. Customer-facing agent creation and configuration remain out of
  scope.
- Local development may fall back to `WORKBENCH_DEV_USER_ID` and
  `WORKBENCH_DEV_WORKSPACE_ID` plus `WORKBENCH_DEV_AGENT_ID` only when WorkOS is
  not configured, `WORKBENCH_ALLOW_LOCAL_DEV_IDENTITY=true`, and the app is not
  running in production. Hosted production fails closed when WorkOS is
  incomplete.

The 1.0 authorization surface includes retained workspace data, brokered
connections, and policy-controlled external mutation. Packs declare needs but
cannot grant authority: retention confirmation, explicit per-tool enablement,
connection health, policy, approval, and kill switches remain platform-owned.

## Ownership Roadmap

The next steps should keep WorkOS and operloom responsibilities separate:

1. Admin visibility: expose the Cloudflare-resolved account, workspace,
   membership, default agent, recent events, and last error in Admin.
2. Workspace management model: one WorkOS organization or personal account can
   own multiple operloom workspaces. Active members can switch assigned
   workspaces; owners/admins can create workspaces and manage membership, with
   Cloudflare storing the active workspace preference.
3. Membership source of truth: WorkOS answers who signed in and which external
   organization they came through; Cloudflare D1 answers what they can do inside
   an operloom workspace. The current v0 keeps reads open to active
   members and gates workspace writes to `owner`/`admin`.
4. Agent routing: agents remain scoped to workspaces. The current v0 keeps
   customer-facing agent provisioning out of scope while Cloudflare stores
   active-agent routing preferences and Admin can create test agents.
5. Agent behavior: active agent behavior is workspace-scoped and Cloudflare
   owned. Repo XML prompts are seed templates; after agent creation, D1
   `agents.data_json.behavior` is the source of truth for the injected system
   prompt.
6. More Cloudflare ownership: Cloudflare should own app authorization, scoped
   state access, events, audit, run control, tool policy, and secret policy.
   The active v0 slice exposes chat runtime state from Cloudflare-owned D1 rows
   after trusted scope resolution.
7. Stronger Vercel-to-Cloudflare trust boundary: Vercel should forward
   server-derived identity through a stricter internal contract, not
   browser-controlled scope.
8. WorkOS organization UX: the current panel surfaces and switches active
   organization memberships. Invitation, domain, and enterprise onboarding
   remain future customer-lifecycle work.

## Failure Modes To Avoid

- Global tool state shared across users.
- Background triggers that wake the wrong workspace.
- Decision records retrieved without tenant filters.
- Artifacts stored under guessable global paths.
- Secrets passed through browser-visible API responses.
- Workflow runners accepting tenant scope from model-generated payloads.

## Acceptance Bar

For 1.0, two users in separate workspaces must receive
isolated agents, chats, runs, tools, artifacts, and history, while role tests
prove that members cannot administer workspace access. Connections, action
proposals, ledgers, exports, deletion, and mutation controls must also return
cross-tenant `404` without disclosing resource existence.
