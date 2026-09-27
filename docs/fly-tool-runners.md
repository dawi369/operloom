# Fly Tool Runners

The signed Node.js runner (`runner/server.ts`) is Operloom's heavy execution
plane. Deployment is covered in [Fly runner deployment](deployment-fly.md).

## Role

The runner executes work that does not belong in Cloudflare Workers:

- CLI tools.
- OSS packages and git submodules.
- Python tools.
- Browser automation.
- Long-running jobs.
- Native dependencies.
- Private network services.

Cloudflare coordinates; the runner executes.

The runner does not own the user-facing stream. It reports results to
Cloudflare through signed callbacks, and Cloudflare streams status and results
to the frontend.

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

Runner tools do not hold D1/R2 credentials. They read and write application
state only through mediated Cloudflare APIs:

```txt
runner tool
  -> scoped Cloudflare API
  -> policy/auth/redaction/audit checks
  -> D1/R2/DO-backed state
```

Direct scoped D1/R2 access would need a measured performance or reliability
problem first, the same scoped interface and the same audit events.

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

## Deployment Modes

- Current hosted mode: each target runs one signed runner app (see
  `config/environments/<target>.json`).
- Future mode: target-scoped runner services may split by tool class behind
  the same signed boundary.

Do not store important durable state on a Fly filesystem unless the storage strategy explicitly says so.
