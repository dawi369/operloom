# Document Review

A Runtime Module v2 example with deterministic word counting and a separate,
budgeted structured-summary workflow. Both detect unchanged document content.

The package supplies a document schema, a scoped resolver, a typed state definition
and two workflows. It uses only `@operloom/agent-sdk`; no frontend is required.
The manifest's untrusted classification cannot be overridden by document content.

## Run locally

Enable `OPERLOOM_PUBLIC_API_ENABLED`, `OPERLOOM_TYPED_STATE_ENABLED`,
`OPERLOOM_CONTEXT_ENABLED`, `OPERLOOM_STRUCTURED_MODELS_ENABLED` and
`OPERLOOM_USAGE_LIMITS_ENABLED` in the local Worker. This repository registers the
example as conformance-only, so also enable `OPERLOOM_CONFORMANCE_MODE` locally.
Use the local authentication setup in [the headless quickstart](../../docs/headless-runtime.md).

With an authenticated `createRuntimeClient` instance:

```ts
// An owner/admin initializes a fresh workspace's limits once.
await client.budgets.update({
  expectedVersion: 0,
  idempotencyKey: "initial-review-budget",
  limits: {
    dailyModelCalls: 20,
    dailyToolCalls: 20,
    dailyTokens: 200000,
    runModelCalls: 2,
    runToolCalls: 2,
    runTokens: 20000,
    concurrentOperations: 2,
  },
});
const { agent } = await client.request<{ agent: { id: string } }>(
  "/agent-packs/document-review/instantiate",
  { method: "POST" },
);
const reviewer = createRuntimeClient({
  baseUrl,
  getAccessToken,
  target: { workspaceId, agentId: agent.id },
});
const result = await reviewer.request<{
  report: { outcome: string; snapshotId: string };
}>("/workbench/workflows/document-review.review", {
  method: "POST",
  body: {
    executionMode: "dry_run",
    input: { documentId: "guide", text: "A short document." },
  },
});
const evidence = await reviewer.context.snapshot(result.report.snapshotId);
```

The first invocation records `reviewed`; an identical next invocation records
`no_change` without incrementing the record version. Both decisions refer to
their own immutable evidence snapshot. Missing text blocks before workflow
execution. Concurrent changes are rejected by an explicit record-version conflict.
Chat uses the same resolver with the latest user text as input.

To summarize, submit the same body to
`/workbench/workflows/document-review.summarize`. The runtime uses its configured
model and server-side OpenRouter credential, validates the summary schema and
records the model reservation alongside the decision. An unchanged document and
effective configuration reuse the stored summary with `no_change` and no new
model admission, even when the model quota is exhausted. Changed input with no
quota is blocked. This workflow demonstrates the interface, not domain-specific
review correctness.

`pnpm conformance:runtime` exercises this journey against a disposable Worker/D1.
Its structured output uses an explicitly local deterministic fixture; it makes no
provider request and reports fixture usage separately. Normal local development
uses the configured provider. Do not enable fixture mode in hosted environments.
`pnpm agent-sdk:verify` also packs and installs the example into an independent
consumer and compiles it using a single package registry entry. Hosted provider
acceptance, durable waits and semantic review quality remain unverified.

The optional durable review captures evidence independently for observation and
recording, with a persisted wait between them. Before recording it checks that
fresh evidence still matches the original document and retains the original state
version precondition. Decisions link both snapshot IDs. Changed evidence blocks
the operation; retrying a logical step never silently replaces its original
capture. Use the headless client's context list to inspect the full revision history.

`document-review.simulate` records a review, a decision and an `effect` entry in
one typed-state commit. The effect is internal state, not an external action, so it
calls `context.state.commit` directly and lands in the agent's pinned effect-target
scope. Its report returns that `target`, the `effectId` and the commit `receiptId`.
