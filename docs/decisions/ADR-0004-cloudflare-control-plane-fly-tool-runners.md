# ADR-0004: Cloudflare Control Plane And Fly Tool Runners

Status: accepted

## Context

Operloom needs a multi-user live agent runtime and a way to run heavy or unsafe tools. Cloudflare-style Agents and Durable Objects fit stateful coordination well. Fly fits normal Linux execution, CLIs, OSS tools, LangGraph workers, and long-running jobs.

## Decision

Use Cloudflare-style agents as the preferred future live multi-user control plane. Use Fly as the default heavy execution plane for tool runners and LangGraph workflow services.

LangGraph remains important as an escalation/workflow engine for graph-shaped workflows with interrupts and resumability. It does not have to be the always-on per-user runtime.

All tool execution crosses a typed, signed, tenant-scoped boundary.

Cloudflare owns the user-facing stream. Fly and LangGraph services report progress and results back to Cloudflare, which streams them to the frontend.

LangGraph and tool runners use mediated Cloudflare APIs for app-state reads and writes in the initial implementation. Scoped direct D1/R2 service access is a future optimization only. It requires a measured hot path and must preserve the same scoped data-client, tenant checks, redaction, and audit model.

## Consequences

- Cloudflare owns coordination, tenant-scoped state access, schedules, triggers, and intent routing.
- Fly owns heavy execution, CLI/OSS tools, submodules, browser automation, and LangGraph workflow workers.
- D1 stores relational control-plane data.
- R2 stores artifacts and blobs, not app database records.
- Every tool call must carry tenant scope, permission context, execution mode/policy, and audit output.
- The frontend streams from Cloudflare, not directly from Fly by default.
- The current assistant-ui chat path uses a LangGraph-shaped browser contract,
  but normal simple chat is Cloudflare-owned. Fly/LangGraph are reserved for
  explicit heavy workflow escalation.
- Workflow DB access is mediated by Cloudflare APIs first to prevent cross-user contamination.
- The current local/Fly LangGraph starter remains useful for development and staged validation while the target runtime evolves.
