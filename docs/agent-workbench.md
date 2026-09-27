# Agent Workbench

## Runtime direction

Explicit v2 simulation actions commit proposed state, decisions and effect receipts
in an isolated backend scope. They share the package/workflow interfaces used by
headless clients; external dispatch remains a separately gated capability.
See [simulation actions](runtime-simulation.md) for current limits.

The approved next delivery makes the backend independently usable by arbitrary
frontends. Packages supply domain schemas and behavior; Cloudflare retains
canonical state and execution authority. The bundled web UI remains one client.
The experimental headless client now exposes state and decision/effect inspection
and authorized failed-event retry. Dedicated bundled operator views remain planned.
Administrators can also advance reviewed schema migrations through the headless
API, with state preserved across interrupted requests.
Reviewed replacement plans can repair unfinished migration batches while retaining
completed state and the full plan history. Execution revision checks now reject
obsolete run admissions and state handles. Explicit in-place package upgrades now preserve snapshot history and validate
retained state/indexes before committing; the interface remains experimental. Pending
chat commands now block upgrades before a run exists; independent clients can
inspect their completion, cancellation or failure through the API.
Opt-in context packages now preserve bounded evidence snapshots for chat and
workflows, with visible required-context blocks. Independent clients can inspect
the same snapshots. The document-review example records a deterministic no-op
when content is unchanged. Experimental structured model work and workspace/run
budgets now reserve capacity before dispatch and retain ambiguous usage. The
document-summary workflow reuses a recorded result when evidence and effective
configuration are unchanged, including when no model quota remains.
See the [gated roadmap](implementation-roadmap.md) and [current delivery evidence](runtime-delivery-status.md).

Durable execution has an internal persistence foundation for submission identity,
checkpoints and attempts, with transactionally enforced authority for state,
context and model/tool admission. A gated native Workflows adapter now runs v2
steps and timer waits independently of the initiating request. Bounded recovery
now closes abandoned or revoked work with recorded outcomes and terminates
cancelled engine instances. New steps refresh evidence after waits while earlier
snapshots remain available through the headless client. Document review blocks a
state change if refreshed document evidence differs from its observation. Optional
human review pauses expose immutable content and expiry through both the API and
web approval views; approval resumes through current backend authority. Opt-in
durable triggers now use the same execution path, preserve event identity across
delivery retries and revoke future work when paused. Hosted
durability, deployed handler retention and complete operator recovery remain
unverified. A local deployment compatibility gate now fences new admissions while
checking the frozen candidate against active handler pins.
Workspace purge now confirms native engine deletion before removing canonical
records. Uncertain creation calls retain a reconciliation fence; native cleanup
progress survives interrupted D1 cleanup.

The workbench is the reusable product layer this repo is meant to become. Chat
remains the first interface, but the product should support long-running agent
work, tools, external triggers, user knowledge, managed state, audit trails,
and multi-user isolation.

The target audience is broader than internal use:

- personal/operator use for my own agent workflows
- developer use, where another dev can define agents in code, run, configure,
  extend, and adopt the source-available workbench under its noncommercial or
  separately agreed commercial terms
- business integration use, where a willing company gets scoped agents inside
  its workflows, permissions, data, approvals, and audit boundaries

Document status: the shipped surface is assistant-ui chat plus local workbench
commands for `/new`, `/agents`, active-agent slash actions, `/history`, and
server-gated `/admin`. Operator checks live in Admin > Diagnostics rather than
the chat command menu. The broader surfaces below are direction, not a claim
that every UI exists today.

## Product Scope

The committed tenant model is workspace plus agent. A separate user-visible
project concept is not part of the current architecture. Product-specific
workbench composition can still show app/domain context, environment, docs,
repo assumptions, or app state.

Reference apps such as Polymancer, deployment agents, and the Personal Job
Agent are benchmark pressure tests. Real customer integrations should follow
the same rule: validate autonomy, secrets, ledgers, browser automation,
external signals, and policy without baking a single domain into the base
workbench.

The capability contract in `capability-model.md` separates operational depth
from external authority. The stable 1.0 target is the web developer workbench and read-only execution.
Background/event-driven operation (L3) and policy-controlled external execution
(A2) remain experimental and disabled by default; see [release scope](release-1.0.md).

## Core Surfaces

- Thread state: idle, running, interrupted, blocked, or failed.
- Run control: start, stop, retry, enqueue, inspect, and resume work.
- Interrupts and approvals: missing input, blocked tools, approval prompts, and
  external resume points.
- Tools: registry, visibility, permissions, policy, recent calls, failures, and
  model-exposure explanations.
- Artifacts and history: files, logs, screenshots, reports, generated outputs,
  traces, and resumable checkpoints.
- Managed state: tasks, deployments, documents, tickets, tracked resources, or
  app-specific ledgers.
- Memory and behavior: durable instructions, knowledge, preferences, tone,
  operating principles, and agent behavior snapshots.
- Decisions: durable "why" records with evidence, alternatives, confidence,
  provenance, and freshness.
- Triggers: heartbeats, webhooks, scheduled checks, external events, and
  domain-specific monitors.

## Current UI Baseline

- Default assistant-ui chat is the normal screen.
- Normal chat uses Cloudflare Agents through `app/assistant.tsx`.
- `/new` starts a local blank session immediately and only materializes a
  Cloudflare thread when the first message is sent.
- The runtime hint shows server-derived workspace, agent/profile, chat state,
  and error detail.
- Recent chat state and active-thread switching are Cloudflare-owned.
- `/agents` opens a compact agent picker. Active-agent pack workflows populate
  the `/` composer menu when they have a safe dry-run binding.
- Repository Analyst and Polymancer Research have current live pack workflow
  bindings. Swordfish remains activatable for prompt/profile/chat behavior but
  declares no executable runtime surface while its reference backend is parked.
- The runnable bindings create Cloudflare-owned workflow intents, runs,
  tool calls, artifacts, audit events, and history entries through a shared
  lifecycle helper.
- `/history` opens the product-facing workbench history drawer for recent
  scoped runs, selected-run summaries, tool calls, and metadata-only artifacts.
  The runtime hint also links directly to this surface.
- `/workspace` opens the product-facing account and access panel for WorkOS
  organization switching, assigned workspace switching, workspace creation,
  owner/admin member controls, retention confirmation, export, and deletion.
- History exposes supported cancellation and pack-workflow retry plus approval
  resume/deny actions. Connection failures expose a direct reconnect action.
- `/admin` opens a server-gated Admin panel and is stripped before model send.
- Admin uses three focused tabs: Controls, Agents, and Diagnostics. It keeps
  pending approvals prominent and pack activation one tab away,
  isolates traces/raw state in Diagnostics, and links normal workspace, agent,
  and history work to their dedicated surfaces.
- Cloudflare exposes backend execution and artifact history metadata through
  scoped workbench APIs. The normal `/history` surface can inspect recent runs
  and artifact metadata; Admin remains the deeper diagnostic surface. A
  mediated D1/R2 API stores, reads, exports, and expires bounded blobs. History
  also projects durable action proposals, approval entry points, terminal
  outcomes, and reconciliation.

## Near-Term Milestones

1. Keep the connected workbench local-feeling: fast first paint, immediate
   draft input, responsive thread switching, and background Cloudflare
   reconciliation.
2. Expand `/history` with more domain renderers and filtering while preserving
   the current previews, action ledger, reconciliation, and workspace export/delete controls.
3. Prove one complete pack-owned application slice across context, tools,
   workflow, artifact rendering, managed state, trigger handling, evals, and
   recovery before widening the external pack contract.
4. Harden model-side tool rendering and approval explanations before broader
   model-visible tool use.
5. Add swappable domain context configuration for downstream apps and customer
   integrations without introducing a committed `Project` entity too early.
6. Add another read-only adapter only when it proves a missing capability-model
   contract rather than adding a one-off integration.
7. Move the remaining Fly/LangGraph producers onto the generic scoped callback
   path.
8. Add generic managed-state and decision surfaces after the 1.0 read-only
   baseline is proven; packs contribute typed descriptors without owning tenant
   scope or core navigation.

## Component Rules

- Keep `components/assistant-ui/*` reusable and product-agnostic.
- Put workbench-specific composition around the thread, not inside low-level
  message rendering.
- Prefer typed data passed into reusable components over global assumptions.
- Keep domain language in reference app configuration. Base components should
  use generic terms such as managed state, ledger, triggers, tools, memory, and
  policy.
- Treat tenant scope as server-derived runtime data, not prompt text.
- Treat tool execution as server-side only. The frontend may request, approve,
  inspect, or configure tools, but it must never receive provider keys, user
  credentials, or tool secrets.

## Tool Requirements

- A new typed tool should be addable with a small module declaring name,
  description, execution function, and proven metadata.
- CLI tools, OSS packages, scripts, and git submodules should sit behind the
  same tool interface as native TypeScript tools.
- Availability should be configurable per user/workspace/agent and deployment.
- Mutation-capable tools must support ask, dry-run, and execute modes, with
  policy checks outside the model.
- Tool output should be structured enough for UI, artifacts, failures, and
  follow-up actions without parsing prose.

## Design Principle

This should feel like an operator surface for serious work: dense,
inspectable, and calm. Avoid turning the workbench into a marketing page or a
generic chatbot wrapper.

### External-action review visibility

Experimental action listings now expose the complete proposal, review hash and
expiry. Reviews bind exact state versions and current authority; stale approvals
cannot silently adopt changed inputs. Operators can deny a pending review, and
expired work closes automatically. Provider operations and final Action detail
views remain unfinished; see [review design](action-review-design.md).

### Provider operations rollout

Reviewed actions can use a named backend provider operation. Packages define the
domain proposal, while the broker owns authentication and permitted destinations.
The initial bearer/HMAC capacity-service integrations are experimental and disabled
by default. Native and hosted operation acceptance remain required; this is not
a general provider marketplace or a financial integration. Independent clients
can inspect redacted dispatch receipts and request reconciliation through the
same backend API. Recovery can prove that no dispatch occurred only by atomically
fencing future dispatch; accepted effects remain visible even if projection fails.
Web History exposes the same redacted action evidence and reconciliation controls,
including resolved outcomes, review bindings and external resource status.
