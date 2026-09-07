# Workbench UI

Operloom is an operator workbench built around chat, not a generic chatbot
wrapper. The UI should make long-running agent work inspectable without hiding
the underlying state.

Document status: the current UI is default assistant-ui chat plus local
commands for `/new`, `/agents`, active-agent slash actions, `/history`, and
server-gated `/admin`. The surfaces below describe the target workbench as
runtime data matures.

## Assistant-UI Leverage Map

Use assistant-ui directly for:

- thread layout
- message rendering
- composer behavior
- attachments where the primitive fits
- tool-call rendering where stream parts map cleanly
- stream ergonomics

Wrap assistant-ui for:

- runtime creation and loading
- interrupt display and resume actions
- tool-call inspection
- artifact previews
- thread/run status coordination

Own outside assistant-ui:

- tenant scope
- secrets
- policy and execution modes
- durable run control
- workflow intents
- ledgers
- managed state
- decision records
- triggers
- external signal state
- Cloudflare/Fly orchestration

`components/assistant-ui/*` should stay product-agnostic. Workbench panels
should compose around the thread.

## Primary Layout

Current implemented layout:

- Main thread region using assistant-ui.
- Top-right auth controls.
- `/new` composer command for entering a local blank session.
- The local `/new` surface renders the complete welcome, static starter prompts,
  and draft composer immediately while Cloudflare staging continues in the
  background. A starter selection or first send queues through the existing
  runtime handoff when the Agent connection is not ready yet.
- `/agents` composer command for active agent selection only.
- `/workspace` composer command and signed-in account control for WorkOS
  organization switching, workspace switching/creation, and scoped member
  administration.
- Active-agent pack workflows populate the `/` composer menu as runnable slash
  actions when a safe binding exists. Selecting one opens a typed dry-run dialog
  with bounded preset fields instead of raw JSON.
- `/history` composer command and runtime-hint action for scoped runs,
  searchable selected-run summaries, tool calls, metadata-only artifacts,
  supported cancel/retry actions, and interrupted approval resume/deny controls.
- `/admin` composer command for the flow-first Cloudflare-owned Admin panel.
- Admin tool actions for read-only adapters and conformance tools, currently
  `url.inspect`, `repo.snapshot`, `diagnostic.ping`, `runner.echo`, and
  `artifact.metadata.test`.
- Cache-backed recent-chat sidebar for display-only workspace history. Cached
  rows can paint immediately, then reconcile with Cloudflare. Archived chats
  prefetch after the trusted session resolves, remain visible while stale data
  revalidates, and refresh after thread mutations, session events, or a stale
  foreground transition. Optimistic deletion closes its confirmation
  immediately; a failed mutation restores the row and exposes a recoverable
  sidebar error instead of reopening the dialog.
- Signed-out recovery state hides cached workspace chrome and provider
  diagnostics, giving the user one clear sign-in path before the composer,
  recent chats, or runtime state become available.
- While AuthKit refreshes on reload, the browser holds a secure session gate
  instead of briefly painting the workbench. A presentation-only browser cookie
  lets the server render later signed-out reloads consistently; it never grants
  access or restores workspace data and is cleared when a live session resolves.
- Connection failures expose a direct reconnect action while preserving deeper
  redacted diagnostics behind Admin.

Remaining target layout:

- Collapsible workbench/admin panel for inspectable runtime state.
- Artifact/history drawer or tab. The current `/history` drawer is the first
  product-facing version; it intentionally exposes search, filters,
  selected-run details, and metadata summaries before blob previews or
  deletion/export controls.
- Tool/policy panel for enabled tools and recent calls.

The first screen should be the usable workbench, not a landing page.

Thread transitions should not blank the whole app after the first successful
Cloudflare Agent connection. `/new` and the sidebar plus button enter a local
blank session immediately, without creating a D1 thread or sidebar row. The
first real send materializes the Cloudflare thread and starts the turn.
Selecting an existing thread may highlight cached state immediately, but
Cloudflare must still confirm the active thread/agent and mint the signed Agent
token before the runtime actually switches.

The workbench shell should paint before the Cloudflare Agent token is ready.
Cached workspace/thread chrome can render immediately, the right-side runtime
hint should show Cloudflare connection state, and sidebar chat actions should
remain disabled until Cloudflare returns a live connection for the active
workspace/thread. This keeps first paint fast without inventing browser-owned
session state.

The shell subscribes to one Cloudflare-owned session event stream after a
trusted session is available. Sidebar state, runtime hint state, Admin
invalidation, and future workflow/tool progress should update from
`session.*`, `chat.run.*`, `tool.run.updated`, `trace.updated`, and
`admin.summary.invalidated` events instead of broad polling. Admin may still
fetch a full summary when opened or invalidated, but low-level details should
stay behind collapsible sections.

## Surfaces

### Thread

Shows conversation, messages, attachments, streaming model/tool activity, and
compact reasoning activity status without exposing raw reasoning text.

Source:

- assistant-ui runtime
- LangGraph thread state
- future control-plane stream

### Run Status

Shows:

- current run status
- execution mode
- workflow stage
- heartbeat freshness
- interrupt/waiting state
- cancellation/retry availability
- parent/child run relation

Source:

- `runs.list`
- active `RunRecord`
- lifecycle events

The normal History surface executes cancellation and supported pack-workflow
retry through Cloudflare-owned scoped routes. Retry creates a new run from the
stored typed workflow input and records the parent run id. Unsupported run
types do not render a retry action.

### Interrupts And Approvals

Shows:

- requested approval
- reason
- proposed action
- execution mode
- approve/deny/resume controls
- policy context

Source:

- active run interrupt state
- scoped Admin approval queue
- workflow engine interrupt
- audit/lifecycle events

Requested tool approvals attached to a selected run render in History with
approve-and-resume and deny actions. The existing Cloudflare approval policy is
re-evaluated server-side; the UI never converts a blocked approval into an
allowed action.

### Artifacts

Shows:

- files
- logs
- reports
- screenshots
- traces
- exports
- generated outputs

Source:

- artifact metadata
- signed/read URLs where allowed

### Execution History

Shows:

- prior runs
- lifecycle events
- tool calls
- failures
- cancellations
- resumable checkpoints when supported

Source:

- runs
- audit events
- tool calls

### Tools

Shows:

- current-agent workflows the user can run
- direct user tools when a pack declares a bound runtime action
- conversational agent-only tools
- workflow-internal adapters
- exposed tools for current run
- hidden tool reasons where useful
- recent tool calls
- permissions
- execution modes
- failures

Source:

- tool metadata
- tool permissions
- tool exposure decisions
- tool call records

### Managed State And Ledger

Shows:

- domain assets the agent owns or watches
- proposed/simulated/executed/skipped/blocked/reviewed actions
- relationship to decisions, artifacts, and tool calls

Source:

- managed state repository
- ledger repository

### Decision Records

Shows:

- thesis/decision
- summary
- confidence/freshness where app-defined
- evidence and counter-evidence
- provenance
- related artifacts and runs
- status: active, superseded, stale, rejected, archived

Source:

- decision records
- artifact metadata
- provenance refs

### Workspace Runtime Context

Shows:

- active workspace
- active agent
- environment
- docs and repo assumptions
- relevant constraints
- current tool/policy footprint

Source:

- workspace context
- agent record
- context assembly metadata

### Memory And Personality

Shows:

- durable user and workspace preferences
- domain knowledge
- risk tolerance
- tone/decision style
- review cadence

Source:

- workspace context
- future memory/personality records or app extension data

### Triggers

Shows:

- schedules
- webhooks
- external event subscriptions
- last/next trigger time
- status
- target workflow type

Source:

- trigger records
- audit events

## Current UI Baseline

Implemented:

- assistant-ui thread remains primary.
- Fresh chat starts through the local `/new` composer command or recent-chats
  sidebar plus button. It stays unmaterialized until the first message is sent.
- The normal shell includes a compact server-derived runtime hint for active
  workspace, active agent/profile, model, chat state, and quick access to
  current-agent Tools, History, plus Admin details when the latest runtime state
  needs attention.
- The `/agents` panel is a compact roster for choosing the active agent. When a
  chat is open, selecting another agent asks whether to continue the current
  chat or start a new chat.
- Active pack workflow bindings appear directly in the `/` composer menu. The
  `/tools` command and normal Tools panel separate user-runnable workflow
  launchers, conversational agent tools, and workflow-internal adapters.
  Repository Analyst and Polymancer Research expose live bounded read-only
  workflows while their adapters remain workflow-internal. Swordfish Runtime
  preserves the same packaged UI contract while its backend is parked.
- The `/history` drawer shows recent scoped runs, selected-run summaries, tool
  call details, child runs, audit events, and metadata-only artifacts outside
  Admin.
- Admin opens from the local `/admin` composer command with four tabs: Overview,
  Agents & Packs, Tools & Approvals, and Diagnostics. Overview keeps current
  workspace/agent/health concise and links to dedicated product surfaces.
- Agents & Packs is the operator switching surface. **Use pack** reuses or
  creates the installed version, starts a fresh chat, and preserves the current
  thread. Custom-agent creation remains secondary.
- Diagnostics contains traces, raw ids/JSON, URL inspection, conformance tools,
  and runtime internals. Normal workspace management and execution history are
  not duplicated in Admin.
- Admin Tools includes a scoped approval queue for `url.inspect`, confirmation
  dialogs for approve/deny, policy-state warnings, and compact latest-approval
  cross-references on tool summaries.
- `url.inspect` can be explicitly exposed to the model only through
  owner/admin policy controls, and the UI explains disabled,
  approval-required, and kill-switch blocks inline.
- `repo.snapshot` is available as a read-only runner-backed adapter with
  bounded options and metadata-only artifacts.
- Admin Test Tools includes `diagnostic.ping`, `runner.echo`, and
  `artifact.metadata.test` as model-hidden, dry-run-only conformance probes for
  policy, runner, callback, artifact, history, and event plumbing.
- Structured pack artifacts and run controls live in `/history`; Admin keeps
  only the deeper diagnostic context.
- Admin summary treats historical tool failures as history once a newer
  completed control run proves the path recovered; stale errors remain
  inspectable through history instead of pinning the global Details state.
- The empty chat state renders the active pack's cached title, description, and
  a balanced two- or four-card starter grid immediately. Non-pack agents keep
  four practical generic starter prompts.

Next UI targets:

- Customer-facing run/status strip only when a real workflow produces state
  richer than the compact chat hint.
- Extend artifact-specific renderers beyond the generic JSON, Markdown, and
  table previews while retaining the D1/R2 export and deletion controls.
- Chat-side approval display through assistant-ui tool rendering when a
  model-side workflow needs approve/deny/resume.
- Broader policy visibility for durable limits and cooldowns beyond the current
  mutation opt-in, approval, connection, and pack/tool/connection kill-switch controls.

Avoid building every panel before one vertical slice produces real data.

## Acceptance Criteria

- User can tell what is running and why.
- User can inspect tool calls without reading raw logs.
- User can inspect durable outputs linked to a run.
- assistant-ui components remain reusable and product-agnostic.
- Workbench-specific state stays outside low-level message components.
