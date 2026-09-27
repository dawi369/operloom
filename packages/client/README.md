# @operloom/client

Framework-neutral TypeScript client for Operloom product APIs. It is used
by the web workbench and is suitable for independent React web clients. Native
consumers are future work on the `codex/mobile-wip` branch.

## Direct Worker API (experimental)

`createRuntimeClient` and `createFetchChatTransport` use the opt-in `/v1` Worker
API directly. They require explicit workspace/agent targets and an application
token provider, with no Next, React, assistant-ui or Cloudflare transport import.
Chat requests return HTTP acceptance independently of streaming; observation uses
SSE replay/reset plus canonical transcript polling. Chat contracts validate
responses at runtime and generate OpenAPI. Administrative schema coverage is
still in progress. The existing `createWorkbenchClient` facade remains compatible.

```ts
import { createRuntimeClient } from "@operloom/client";

const runtime = createRuntimeClient({
  baseUrl: "https://runtime.example.com",
  target: { workspaceId, agentId },
  getAccessToken: ({ forceRefresh, minValidityMs }) => auth.token({ forceRefresh, minValidityMs }),
});
const { threadId } = await runtime.threads.create();
await runtime.threads.submit(threadId, "Summarize current work", crypto.randomUUID());
const transcript = await runtime.threads.messages(threadId);
```

See the [headless runtime guide](https://github.com/dawi369/operloom/blob/main/docs/headless-runtime.md)
for authentication, backend-only development and current acceptance limitations.

### External action inspection and recovery

`runtime.admin.actions({ limit: 25 })` returns canonical proposals, immutable
review hash/expiry, ledger and redacted provider receipts. Dispatch status and
external resource lifecycle are separate: a succeeded dispatch may return a
pending resource. The list is bounded; cursor pagination is not yet implemented.

`runtime.admin.requestAction(id)` returns HTTP `202` with the required approval
identity and review binding. `runtime.admin.reconcileAction(id)` observes or
repairs an existing action; `ok: false` means it remains unresolved (`202`).
These methods validate responses against shared schemas also used for OpenAPI.
Requesting execution requires administration and current execution authority.
Reconciliation never submits another provider mutation. When dispatch never
started, atomic recovery fences future admission before recording `not_dispatched`.
Refresh canonical status after recovery; a reconciled action need not mean an
external effect occurred. Approval decisions use the existing scoped approval API.

## Existing web facade

```ts
import { createWorkbenchClient } from "@operloom/client";

const client = createWorkbenchClient({
  baseUrl: "https://assistant.example.com",
  getAccessToken: () => auth.getAccessToken({ minValidityMs: 60_000 }),
  client: { platform: "web", version: "1.0.0" },
});

const { agents } = await client.agents.list();
```

The package supplies runtime-validated clients for sessions, threads,
workspaces, agents, workflows, History, approvals, connections, actions,
managed state, devices, and notification preferences. It also defines the
stable chat/realtime contracts and an exactly-once pending-turn controller.

Authentication remains application-owned. Omit `getAccessToken` for a
same-origin WorkOS cookie session; provide it for public browser or native
bearer clients. The package never stores credentials, owns UI/cache state, or
contains service secrets. Invalid successful responses fail closed as a
`WorkbenchClientError` with `code: "invalid_response"` without exposing the
response body.

This package is private and initially unpublished. From the repository, run
`pnpm workbench client pack` to create checked archives and a checksum manifest
under `output/client-distribution/`.

See the [frontend integration guide](https://github.com/dawi369/operloom/blob/main/docs/frontend-integration.md).

## Typed state operations (experimental)

`runtime.state.records({ target, namespace, kind, limit?, cursor? })`,
`runtime.state.entries({ target, type?, limit?, cursor? })`, and
`runtime.state.deliveries({ target, status?, limit?, cursor? })` expose canonical
state with runtime-validated responses. `target` is always `simulation` or
`external`. The server chooses tenant/package scope. Cursors cannot be reused
with different filters or targets.

Owners/admins can call `runtime.state.retryDelivery(id, { target,
expectedAttempts })` using an observed failed delivery. A `202` response confirms
durable retry acceptance; a `409` requires refreshing canonical status. The
scheduler reuses the event identity. This operation does not execute an external
provider action. All state methods require the backend typed-state feature flag.

`state.migrations({ target })`, `state.startMigration(id, target)` and
`state.advanceMigration(id, { target, expectedRevision })` expose reviewed schema
migrations. `state.repairMigration(id, { target, expectedRevision, replacementId,
idempotencyKey })` selects a registered replacement for unprocessed records only.
The replacement must retain schemas/indexes; repair preserves completed state and
returns an idempotent receipt. Start, advance and repair require an admin role.

### Inspect an accepted chat command

`threads.submit(threadId, text, key)` returns an optional `commandId` (older
receipt replays may omit it). `threads.command(commandId)` retrieves its canonical
status, linked run, acceptance time and error code. `threads.cancel(threadId)`
revokes pending command admission as well as interrupting active chat. Replay of
a failed command does not resubmit model work; inspect the outcome before using
a new key. The `chat.command.updated` event also publishes durable status changes.

The experimental `runtime.packages.snapshots(beforeRevision?)` and
`runtime.packages.upgrade({ targetVersion, expectedRevision, idempotencyKey })`
methods expose explicit idle-agent upgrades without a frontend dependency.
They require workspace admin authority and the Worker package-upgrade flag.
Retain the exact body/key for response-loss retries; a changed payload conflicts.

`runtime.context.snapshot(id)` retrieves immutable scoped evidence linked to a
workflow or chat run. It includes source trust, freshness, provenance, package/
runtime/configuration versions and ready/blocked status. Read authority follows
current workspace membership; quarantine denies access until recovery.

### Resource budgets and usage

With `OPERLOOM_USAGE_LIMITS_ENABLED=true`, owners/admins use `runtime.budgets.get()`
and `runtime.budgets.update({ expectedVersion, idempotencyKey, limits })` to inspect
and change workspace limits. Limits cover daily and canonical root-run model/tool
calls and tokens, plus workspace concurrent operations. A workspace must have an
explicit policy before calls are admitted. Lowering a limit does not erase usage.

`runtime.budgets.usage({ day: "2026-09-27", limit: 50, cursor })` lists reservation
metadata without prompts or model output. Totals distinguish provider-reported
`knownTokens`, synthetic `fixtureTokens` and conservative `estimatedTokens`.
Listen for durable `usage.reserved`, `usage.settled` and `budget.updated` events,
then refresh canonical status. Uncertain calls remain charged and require inspection;
they are never automatically dispatched again.

Context capture history is available without a framework:

```ts
const page = await runtime.context.list({ runId, runKind: "workflow", limit: 20 });
const next =
  page.nextAfterRevision === undefined
    ? undefined
    : await runtime.context.list({
        runId,
        runKind: "workflow",
        afterRevision: page.nextAfterRevision,
      });
const evidence = await runtime.context.snapshot(page.snapshots[0].id);
```

The list contains metadata only; evidence is fetched on demand. Revisions remain
available after later durable steps refresh their context. Historical snapshots
may omit capture metadata in their original JSON.

Approval-list results and run interventions can carry a `WorkflowReviewDescriptor`
in `review`: immutable `payload`, SHA-256 `requestHash` and `expiresAt`. Render this
content before offering approve/deny. Existing scoped `/tools/approvals/:id/approve`
and `/deny` commands decide the request; denial accepts an optional reason.
An approved durable review remains waiting until the runtime rechecks live
authority and consumes it. Approval is a human review receipt, not permission
to dispatch tools or external effects. Observe canonical run state after deciding.
