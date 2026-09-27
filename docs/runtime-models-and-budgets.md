# Structured model calls and resource budgets (experimental)

Cloudflare owns model selection, provider credentials, reservations and evidence.
Packages receive a structured-call port with an output schema, bounded prompt,
output-token limit and stable operation key. They cannot choose credentials or a
provider endpoint. The existing AI SDK/OpenRouter integration executes one call
with automatic retries disabled; the SDK validates the returned object again.
Only public output and usage are persisted, never hidden model reasoning.

D1 already supplies the transaction and lifecycle primitives this requires; no
new storage or queue service is necessary. A reservation receipt checks current
authority, run state, agent revision, kill switches, required-context expiry and
workspace/run limits atomically before dispatch. Daily workspace limits cover all
members and agents. Child tools count toward their canonical parent run. Limits
are configured by workspace admins with a version check and idempotent receipt.

Model/tool call counts are exact dispatch admissions. Token reservations use a
conservative input estimate plus the output cap. Provider-reported usage is stored
separately and replaces the estimate when known; actual tokens can exceed an
estimate, after which further calls are blocked. This is not a dollar-spend cap.
Uncertain calls retain their estimated charge and cannot be automatically replayed.
Unfinished reservations cease occupying concurrency slots after their bounded
deadline, but their call/token charges remain. Cancellation never refunds an
already admitted operation. This prevents response loss from minting new budget.

Immutable configuration receipts, reservations and model results participate in
export, quarantine and deletion. No prompts or provider error bodies are copied
into usage metadata. Structured calls reuse the recorded result for the same
run/key/payload; a changed payload conflicts. An unrecorded outcome requires a new
explicit operation key and another reservation.

## Enable and operate

Enable `WORKBENCH_USAGE_LIMITS_ENABLED` for shared chat/tool admission and
`WORKBENCH_STRUCTURED_MODELS_ENABLED` for the workflow model port. V2 packages
declare `usage.reservations.v2` and `models.structured.v2`. With the flags off,
existing v1 behavior is unchanged. With usage enforcement on, a workspace must
have an explicit policy before any model/tool admission.

Owners/admins configure limits through `runtime.budgets.update({ expectedVersion,
idempotencyKey, limits })`. Limits include `dailyModelCalls`, `dailyToolCalls`,
`dailyTokens`, `runModelCalls`, `runToolCalls`, `runTokens` and
`concurrentOperations`. Zero disables new admissions for that resource. Daily
counters use UTC; run counters survive day boundaries. Already admitted work
continues to count after a policy change. A policy revision racing admission can
reject that admission; clients inspect the canonical error before trying again.

The Fetch client exposes `budgets.get()` and paginated `budgets.usage({ day, limit,
cursor })`. Reads and configuration require workspace admin authority. Durable
`budget.updated`, `usage.reserved` and `usage.settled` events prompt clients to
refresh canonical state. Settlement publication and receipt updates are atomic.
Usage metadata omits prompts and model output. Export includes retained model
results under the workspace's normal export authorization.

Admission counts represent reserved attempts: a crash before network dispatch may
still consume a call. Provider-reported tokens and fixture tokens are distinct;
partial or missing usage retains the full estimate. Concurrency covers outstanding
reservations until the declared execution deadline plus 30 seconds, not a proof
that a remote provider has stopped. Current call-count limits are capped at 10,000
per kind/day and token limits at 100 million. SQL uses indexed receipt aggregates;
hosted latency/throughput at these bounds has not been measured.

Required context is rechecked at admission. The effective model configuration is
included in the context configuration hash, so an inherited model change cannot
silently reuse a summary's old no-op decision. Workflow budget/evidence blocks
return `409` with the canonical error code. HTTP chat acceptance still returns
before execution; inspect its command outcome for `resource_admission_denied` or
`budget_not_configured`.

Implementation and acceptance status is recorded in
[the delivery ledger](runtime-delivery-status.md). New model/budget capabilities
remain disabled until their acceptance gates pass.

Primary contracts: [AI SDK structured output](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
and [D1 transactional batches](https://developers.cloudflare.com/d1/worker-api/d1-database/).
