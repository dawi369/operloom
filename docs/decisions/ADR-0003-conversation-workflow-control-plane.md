# ADR-0003: Conversation To Workflow Control Plane

Status: accepted

## Context

Operloom needs to stay generic while still supporting demanding apps like Polymancer. Not every user message should start a heavy agent graph. Many interactions are simple: answer from memory, explain current state, edit notes, inspect strategy, or summarize recent activity.

Complex workflows still matter. Trading, deployment, research, and operations agents all need explicit multi-step execution, tool calls, approvals, execution policy gates, and durable audit trails.

## Decision

Split the agent system into a conversational control plane and workflow execution plane.

The conversational agent owns the fast user-facing loop. It reads and updates canonical state, answers questions, edits memory/personality, and emits typed workflow intents when escalation is needed.

Workflow engines execute typed intents. LangGraph is the preferred engine for complex graph-shaped workflows with explicit stages, interrupts, and resumability. Simpler workflows may run in a Cloudflare-style stateful agent. Heavy tools, CLI tools, OSS packages, and submodules run in server-side tool runners such as Fly services.

All durable state is scoped by `userId` and `workspaceId`. The model never decides tenancy.

## Consequences

- Chat stays responsive because simple questions do not require full graph execution.
- Complex work is explicit, inspectable, and auditable.
- Polymancer becomes one reference mapping, not the repo identity.
- Workflow stages are generic: `observe`, `analyze`, `propose`, `execute`, `review`.
- Every escalation carries tenant scope, deterministic execution mode, optional policy name, and payload.
- Workflow outputs must write back decision records, artifacts, ledger/audit events, and managed state updates.
