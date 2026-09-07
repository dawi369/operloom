# Tool System

Operloom tools are server-side capabilities with typed inputs, typed
outputs, policy checks, audit behavior, and UI inspection. The model should see
only the tools allowed for a specific scoped run.

## Assistant-UI Boundary

assistant-ui should render streaming tool-call states where the stream shape
fits. Operloom owns the durable tool system around that rendering:

- tool registry and metadata
- tenant-scoped enablement
- policy and execution modes
- secret access
- redaction
- tool-call records
- artifacts and logs
- audit events
- CLI/OSS process behavior

Low-level assistant-ui tool-call components should stay reusable. Workbench
panels can show durable tool history, permission state, policy state, and
artifacts around the thread.

## Registration Vs Exposure

Registration means the platform knows a tool exists.

Exposure means a specific model run can see and call the tool.

The durable registry may contain many tools. The tool exposure resolver narrows
that list based on:

- tenant scope
- agent/workspace configuration
- tool permission record
- workflow stage
- execution mode
- policy reference
- parent/child run context
- runtime platform constraints

The resolver should return visible tools plus explanation metadata for hidden
or exposed decisions.

The provisional runtime contract is `ToolExposureResolver`. It receives
candidate runtime tool definitions and scoped run context, then returns
visibility decisions for that run.

Dynamic capability resolution v0 is implemented in the Cloudflare control
plane for registered tools. `GET /tools` returns a `capabilityContext`,
`capabilityDecisions`, and each tool's matching `capability` decision for a
requested context:

- `stage=observe|analyze|propose|execute|review`
- `executionMode=ask|dry_run|execute`
- `surface=admin_list|admin_run|admin_resume|model_exposure|model_tool_call`
- optional `featureFlags` as a comma-separated diagnostic list

The resolver is policy-backed, tenant/workspace/agent scoped, and currently
tool-only. It reuses existing `tool_permissions` and policy evaluation; it does
not add model-visible tools, new runners, new schemas, or new execution rights.
Unsupported query values fall back to safe defaults for inspection.

Capability decisions also include `connectionAuth`. In the current slice both
registered tools report `not_required`, `principal=none`, no token refresh, and
`policy_before_connection`. Future connected tools should use the same shape to
report app/user principals, connection-scoped tool filters, authorization
required events, and token-refresh brokerage without exposing secrets.

## Tool Definition

A runtime tool should declare:

- stable name
- human-readable description
- kind or family
- input contract
- output contract
- required secrets
- supported execution modes
- timeout behavior
- cancellation behavior
- logging and redaction behavior
- artifact outputs
- execution function

Runtime definitions may contain functions and must not be persisted directly.
Durable registries store serializable metadata instead.

## Tool Families

Supported families:

- Native TypeScript tools.
- API-backed tools.
- CLI-backed tools.
- OSS package wrappers.
- Git submodule or vendored package adapters.
- Browser automation tools.
- Workflow-engine tools that call another service.

All families use the same framework boundary: scoped input, policy check,
server-side execution, structured output, audit, and artifacts.

## Execution Modes

- `ask`: model may reason and propose but cannot mutate external state.
- `dry_run`: tool may simulate and return proposed effects.
- `execute`: tool may mutate only when policy allows it.

Mutation-capable tools must support `dry_run` before `execute`. If a provider
cannot dry-run safely, the adapter must document that limitation and stay
disabled for live mutation until policy explicitly allows it.

## Tool Call Lifecycle

```txt
tool requested
  -> exposure check
  -> policy check
  -> secret lookup if needed
  -> record ToolCall started
  -> execute with timeout/cancellation
  -> create artifacts/logs if needed
  -> record ToolCall finished
  -> append audit event
  -> return structured result to workflow/model/UI
```

Failure still records a finished tool call with error summary and audit event.

## CLI And OSS Adapters

CLI/OSS tools must define:

- executable or package entrypoint
- working directory rules
- env allowlist
- timeout
- cancellation strategy
- stdout/stderr capture policy
- redaction rules
- artifact promotion rules
- deterministic dry-run mode when mutation is possible

Do not pass broad environment variables or credentials into CLI tools. Provide
only scoped, approved secrets required by the tool.

## Structured Output

Tool output should be structured enough for the UI to display:

- status
- summary
- important values
- artifacts
- follow-up actions
- retryability
- policy blocks
- redacted error details

The UI should not parse prose to determine what happened.

## Redaction

Never expose secrets in:

- model-visible tool output
- browser responses
- logs
- artifacts
- audit summaries
- error messages

Adapters should redact before writing artifacts and again before returning data
to the model or UI.

## Operator Diagnostics

`diagnostic.ping`, `runner.echo`, and `artifact.metadata.test` are platform-owned
operator diagnostics. Pack tools—including model-visible Fly tools—resolve from
the compiled runtime registry and use the same policy, dispatch, lifecycle,
artifact, and audit boundaries as workflows.

## Current Read-Only URL Tool

`url.inspect` is the current public-web read-only adapter. It is read-only,
dry-run only, and can be exposed to the model only by explicit policy opt-in
for the current user/workspace/agent permission row.

Behavior:

- Accepts `{ url }`.
- Supports `dry_run` only.
- Uses policy reference `tool-admin-readonly-v0`.
- Allows only public `http` and `https` URLs.
- Rejects embedded credentials and obvious local, private, or metadata hosts.
- Uses a timeout and bounded response read.
- Returns structured status, content metadata, timing, optional page title, and
  retryability.
- Records workflow intent, run, tool call, artifact, audit events, and
  control-plane events in Cloudflare-owned state.
- Executes only through its compiled signed Fly binding and stamps durable
  runtime/binding/runner metadata on run, tool-call, artifact, and event data.
- Carries `runner.sandbox` lifecycle/network metadata. The current contract is
  per-invocation, ephemeral filesystem, no workspace-persistent state, metadata
  artifact promotion only, public web egress, and private network denied.

This still does not add secret custody, mutation-capable execution, or
model-side approval UI.

## Current Read-Only Repo Tool

`repo.snapshot` is the first serious CLI/OSS-style adapter. It is read-only,
dry-run only, and designed to prove the runner boundary without handing the
model a shell.

Behavior:

- Accepts only bounded options, not arbitrary commands or filesystem paths.
- Runs a fixed repo-inspection command set through the signed runner boundary.
- Uses a sandbox contract with no network egress, ephemeral filesystem,
  timeout, stdout/stderr byte limits, and redaction.
- Does not depend on `.git` being available in the deployed image.
- Returns structured repo summary metadata: package manager, scripts, selected
  repo files, docs/config signals, command metrics, and redacted error details.
- Promotes only metadata artifacts, currently
  `d1://control-plane/{runId}/repo-snapshot-report.json`.
- Is Admin-visible by default and model-hidden unless explicit policy enables
  model exposure for the current user/workspace/agent scope.
- Uses signed progress and staged-artifact callbacks. Cloudflare remains the
  terminal authority and atomically promotes evidence with the run/intent/audit
  terminal transition. The Admin `/tools/runs` facade returns the supported
  synchronous-compatible completed/failed response.

This adapter is the template for future read-only CLI/OSS tools: fixed inputs,
fixed execution contract, structured output, policy before exposure, and
Cloudflare-owned run/artifact/audit/trace records.

## Admin Conformance Tools

Admin conformance tools exercise the tool system without widening product risk:

- `diagnostic.ping`: Cloudflare-inline deterministic probe for policy, run,
  tool-call, audit, event, trace, and history plumbing.
- `runner.echo`: signed Fly runner probe for runner dispatch and callback-owned
  lifecycle. It has bounded string/options input and no artifact by default.
- `artifact.metadata.test`: Cloudflare-inline metadata artifact creator that
  writes a `d1://control-plane/{runId}/artifact-metadata-test.json` reference.

These tools are owner/admin visible, model-hidden, dry-run-only,
non-mutation-capable, and non-policy-editable. They should stay boring and
deterministic; they exist to prove the control plane, not to become product
features.
