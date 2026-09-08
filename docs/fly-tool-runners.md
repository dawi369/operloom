# Fly Tool Runners

Fly is the preferred heavy execution plane for operloom.

## Role

Fly services should run work that does not belong in Cloudflare Workers:

- CLI tools.
- OSS packages and git submodules.
- Python tools.
- Browser automation.
- LangGraph workflow workers.
- Long-running jobs.
- Native dependencies.
- Private network services.

Cloudflare coordinates; Fly executes.

Fly does not own the user-facing stream. Tool runners and LangGraph services report progress to Cloudflare through callbacks or scoped status writes. Cloudflare then streams status and results to the frontend.

## Tool Call Boundary

All tool calls from the control plane to Fly should be signed, typed, tenant-scoped, and auditable.

Minimum request shape:

```json
{
  "scope": { "userId": "user-id", "workspaceId": "workspace-id" },
  "runId": "run-id",
  "workflowIntentId": "intent-id",
  "toolName": "tool.name",
  "execution": { "mode": "dry_run", "policy": "default" },
  "input": {}
}
```

The Fly service must:

- Verify the request signature.
- Validate tenant scope and tool permission.
- Validate the runner sandbox contract.
- Enforce timeout and cancellation policy.
- Enforce execution mode and approval requirements.
- Enforce egress policy before external network access.
- Redact secrets from logs and responses.
- Return structured output and artifact references.
- Write or return audit summaries for persistence.
- Report status against the control-plane run record rather than owning the
  user-facing stream.

## Mediated State Access

Fly services should not use broad D1/R2 credentials. The initial implementation uses mediated Cloudflare APIs for app-state reads and writes.

Preferred access pattern:

```txt
Fly/LangGraph workflow
  -> scoped Cloudflare data API
  -> policy/auth/redaction/audit checks
  -> D1/R2/DO-backed state
```

Future optimization: scoped direct D1/R2 access may be considered only after a measured performance or reliability problem. It must use the same scoped data-client interface and produce the same audit events. It is not part of the initial implementation.

See `docs/db-contracts.md` for the durable entity contracts and repository-style operation groups Fly/LangGraph should call through the mediated data client.

## Sandbox Lifecycle And Network Policy

Sandbox lifecycle/network policy v0 is a signed runner contract, not a new
infrastructure resource. Cloudflare attaches a compact `runner.sandbox` object
to runner metadata and Fly invocation bodies. The current `url.inspect`
contract states:

- lifecycle template: `url-inspect-v1`
- setup: per invocation
- filesystem: ephemeral
- workspace state: none
- artifact promotion: metadata only
- network: public web egress only
- schemes: `http` and `https`
- private network egress: denied
- enforcement: control plane and runner

The Cloudflare control plane derives allowlist, denylist, and runtime-limit
fields from existing tool policy constraints. The Fly gateway rejects missing
sandbox contracts and blocks `url.inspect` requests whose target host does not
match the signed sandbox egress policy. This slice does not create persistent
sandboxes, volumes, browser automation, artifact stores, or a broader network
policy service.

## LangGraph On Fly

LangGraph can run on Fly as a workflow service for complex graph-shaped work. In that model, Cloudflare creates a typed workflow intent, policy approves it, and Fly executes the LangGraph workflow. Final outputs must return to canonical state: decision records, audit events, artifacts, ledgers, and managed state.

LangGraph workflows may need to read and write context. The initial implementation should do that through a scoped data client backed by mediated Cloudflare APIs, not through global database access.

## Deployment Modes

- Current hosted mode: distinct acceptance and production Fly apps each run the
  gateway, LangGraph runtime, and signed executor endpoints.
- Future execution mode: one or more target-scoped Fly services may split tool
  runners and LangGraph workers behind the same signed boundary.

Do not store important durable state on a Fly filesystem unless the storage strategy explicitly says so.
