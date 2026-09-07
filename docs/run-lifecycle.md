# Run Lifecycle

`RunRecord` is the runtime control-plane record for one foreground, background,
workflow, or child execution attempt. It is not a chat transcript, not a
LangGraph-only concept, and not a storage schema.

The purpose of a run record is to make execution inspectable, cancellable,
resumable where possible, and auditable across UI, control plane, workflow
engines, and tool runners.

## Ownership

- assistant-ui owns the local chat/thread experience and streaming primitives.
- LangGraph may own workflow-engine state, checkpoints, interrupts, and engine
  run IDs.
- Operloom owns `RunRecord` as the product-level control object.
- Cloudflare-style control plane is the target owner for creating and updating
  run records.
- Fly/LangGraph report status and durable outputs back through scoped data-client
  operations or callbacks.

## Required Links

A run should link to:

- `scope`: trusted `userId` and `workspaceId`.
- `agentId`: configured assistant instance.
- `threadId`: conversation or task continuity when available.
- `workflowIntentId`: typed escalation request when the run came from an
  intent.
- `externalRunId`: workflow-orchestrator run id, such as a delegated LangGraph
  run. Fly tool-job ids belong in runner/tool-call metadata instead.
- `relation`: `parentRunId`, `rootRunId`, depth, and durable-child flag.
- Durable outputs: tool call IDs, artifacts, decision records, ledger entries,
  and audit events.

The model never supplies tenant scope or parent/child ownership metadata.

## Statuses

Allowed statuses:

- `queued`: accepted by control plane but not executing.
- `running`: actively executing or streaming.
- `waiting`: paused for runtime-controlled scheduling, backoff, or an external
  dependency that is not a user approval.
- `interrupted`: paused for human approval, missing input, blocked credentials,
  or another explicit resume point.
- `completed`: finished successfully and wrote required durable outputs.
- `failed`: stopped because of an unrecovered error.
- `cancelled`: stopped by user, policy, parent cancellation, or system shutdown.

## State Transitions

Allowed transitions:

```txt
queued -> running
queued -> cancelled
running -> waiting
running -> interrupted
running -> completed
running -> failed
running -> cancelled
waiting -> running
waiting -> failed
waiting -> cancelled
interrupted -> running
interrupted -> failed
interrupted -> cancelled
```

Terminal statuses are `completed`, `failed`, and `cancelled`.

Do not transition from a terminal status back to active execution. Create a new
run for retry and link it through `data.retriedFromRunId` or a future explicit
retry relation if repeated usage proves that field belongs in the core.

## Heartbeats

Active runs should update `heartbeatAt` often enough for the UI and control
plane to distinguish alive, stale, and lost work.

Default behavior:

- Foreground chat: heartbeat on stream activity or significant lifecycle event.
- Background workflow: heartbeat at step boundaries and long-running intervals.
- Tool runner: heartbeat before tool start, after tool finish, and during long
  tool execution if supported.

A stale heartbeat does not automatically mean failure. The control plane should
mark stale/lost behavior through policy or operational code, then emit an audit
event explaining the decision.

## Interrupts And Resume

Interrupts are the correct primitive for approvals, missing input, blocked
credentials, and user confirmation.

Rules:

- Set run status to `interrupted`.
- Set `currentInterruptId` or equivalent extension data.
- Emit `run.interrupted` and `approval.requested` when user approval is needed.
- Do not perform non-idempotent side effects before an interrupt unless the
  workflow engine guarantees exactly-once behavior.
- On resume, transition `interrupted -> running`.
- On denial or timeout, transition to `cancelled` or `failed` according to
  policy.

Unified HITL v0 wraps current approval requests in a generic
`humanIntervention` summary. The existing `url.inspect` approval endpoints stay
stable, but approval list responses, approval action responses, durable
`approval.updated` events, and live session `approval.updated` events now expose
the same compact shape: intervention id, kind, state, required action, run id,
workflow intent id, tool id, resume surface, and redacted reason/policy context.
This gives future clarification, credential, and confirmation interrupts a
shared product contract without adding a new schema in this slice.

## Cancellation

Cancellation should be explicit and auditable.

Cancellation sources:

- User action.
- Parent run cancellation.
- Policy or kill switch.
- Timeout.
- System shutdown or deploy.

Cancellation rules:

- Transition active run to `cancelled`.
- Set `cancelledAt`.
- Atomically revoke the run's authority to publish tool results or artifacts.
- Reject late completion, failure, and artifact promotion from cancelled work.
- Emit `run.cancelled`.
- Attempt best-effort cancellation of workflow engine run or tool process.
- Write audit event with actor, source, and reason.
- Cascade cancellation to non-durable child runs unless policy says otherwise.

Bounded inline work has no physical abort adapter. Cancellation
is still authoritative because it durably revokes publication authority. Future
LangGraph and Fly job adapters may use external run ids for best-effort abort.
For external mutations, cancellation also cannot reverse a side effect already
accepted by a provider; ambiguous outcomes enter reconciliation instead.

## Child Runs

Child runs represent delegated or subagent work.

Rules:

- Inherit trusted tenant scope from parent runtime.
- Set `parentRunId` and `rootRunId`.
- Increment `depth`; enforce max depth before creating the child run.
- Receive narrowed tool exposure.
- Return structured summary and durable outputs to parent.
- May outlive parent only when `durableChild` is true and policy allows it.
- Parent completion does not erase child history.

Default max depth for the first implementation should be `1` unless a workflow
explicitly needs deeper orchestration.

Current v0 is inspection-first. Cloudflare `url.inspect` runs persist
`data_json.relation` in existing control-run and tool-call JSON, keep
`data_json.parentRunId` as a compatibility alias when present, and expose direct
children from the existing Admin run snapshot. Explicit child creation is
accepted only when the parent control run resolves inside the same trusted
tenant/workspace/agent scope. Attempts to create a grandchild are blocked with
`child_run_depth_exceeded` and emit a compact control-plane event. No new schema,
autonomous subagent runtime, or durable child execution engine is introduced in
this slice.

## Failure Classification

Store detailed failures in audit events, tool calls, and artifacts. Keep
`failureSummary` short and safe for UI display.

Suggested failure categories in `data`:

- `tool_error`
- `policy_block`
- `user_denied`
- `timeout`
- `cancelled_by_parent`
- `engine_error`
- `provider_error`
- `validation_error`
- `unknown`

Failures that include secrets, stack traces, raw model prompts, or raw tool
outputs should be stored as redacted artifacts when needed.

## Durable Outputs

Before `completed`, important workflow outcomes should write durable records:

- Decision records for why the agent believes, proposed, or chose something.
- Tool call records for execution attempts.
- Artifact metadata for logs, reports, screenshots, traces, and exports.
- Ledger entries for proposed, simulated, executed, skipped, blocked, or
  reviewed actions.
- Audit events for lifecycle, policy, approval, and tool boundaries.

Summaries are indexes, not truth. The durable records and linked artifacts are
the source of truth.

## Acceptance Criteria

- UI can show current run status, failure reason, heartbeat freshness, and
  whether cancellation/resume is available.
- External and scheduled work can be associated with the correct thread and
  tenant.
- Child work is inspectable after parent completion.
- A failed or cancelled run still leaves enough audit evidence to answer what
  happened.
