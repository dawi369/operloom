# Personal Job Agent Reference App

The Personal Job Agent is a demanding reference target for operloom. It
proves the framework can support web-browsing, long-running, stateful agents
that discover opportunities, build a durable application database, and act
through policy-controlled tools.

It is not a separate runtime. It is a reference mapping for a personal job
search operator built on the same generic primitives as Polymancer, deployment
agents, and future operloom apps.

## Vision

The Personal Job Agent is a job-search operator that can browse the web, find
roles, evaluate fit, prepare application packets, apply through complex forms,
track outcomes, and follow up. A user should be able to chat with it about the
live database of discovered, applied, in-progress, rejected, paused, and
follow-up jobs.

The useful version is not a static application tracker. It is an agent with
memory, browser tools, durable records, application artifacts, follow-up
schedules, execution policies, and a clear audit trail. Full autopilot is the
north star, but live submissions must run through scoped credentials, explicit
policy, limits, kill switches, and auditable execution modes.

## Why This Reference App Matters

Job search stresses framework primitives that generalize beyond recruiting:

- Autonomy: discovery, application preparation, follow-ups, and status checks
  need to run without an open browser.
- Browser automation: many useful actions happen through complex web forms,
  company career sites, job boards, and applicant tracking systems.
- Personal data: resumes, profiles, work history, compensation preferences, and
  private correspondence must stay scoped and redacted.
- Ledgers and audit: discovered jobs, skipped roles, drafted applications,
  submissions, responses, interviews, and follow-ups need durable records.
- Policy: full autopilot needs deterministic execution modes, allowlists,
  denylists, rate limits, cooldowns, approval gates, and kill switches.
- Multi-user isolation: every user needs separate profiles, preferences,
  applications, credentials, browser sessions, artifacts, schedules, and audit
  logs.

These requirements are generic. The same framework should support other
personal operators that browse, decide, submit forms, track outcomes, and answer
"what happened and why?" from durable state.

## Core Capabilities

- Job discovery: browse job boards, company career sites, newsletters, search
  results, and user-provided links for relevant roles.
- Progressive database creation: extract companies, roles, requirements,
  locations, compensation, application URLs, deadlines, status, and source
  provenance as the agent works.
- Fit analysis: compare roles against user goals, skills, work history,
  preferences, constraints, and prior decisions.
- Application packet generation: prepare tailored resume variants, cover
  letters, answers, portfolio links, and supporting notes.
- Browser-based application flow: dry-run forms, detect missing information,
  capture screenshots or artifacts, and submit only when policy allows.
- Status tracking: keep application state, response state, interview state,
  follow-up dates, blocked requirements, and outcomes current.
- Follow-up automation: schedule reminders, draft messages, and later integrate
  inbox or calendar signals when credentials and policy are ready.
- User knowledge: store preferences such as role type, seniority, location,
  salary floor, remote policy, visa constraints, company denylists, and writing
  style.
- Chat over state: answer "what am I waiting on?", "which jobs need follow-up?",
  "why did you skip this role?", and "what are you applying to today?" from
  managed state, decision records, ledgers, artifacts, and tool history.

## Framework Mapping

Personal Job Agent behavior must map to generic operloom primitives:

- Live chat -> Cloudflare `AIChatAgent` thread runtime for conversation only;
  job records, browser tools, profile data, policies, credentials, schedules,
  and audits stay in generic Cloudflare/Fly framework primitives outside the
  per-thread Agent.
- User career profile -> user/workspace-scoped memory and managed state.
- Job database -> managed state records with domain-specific fields in `data`.
- Job discovery monitor -> scheduled run or external trigger.
- Browser automation -> typed server-side tool family with artifacts and
  redaction.
- Application packet -> artifact metadata plus managed state references.
- Application proposal -> decision record and ledger entry.
- Dry-run application -> tool call, artifact, and ledger entry without external
  mutation.
- Submitted application -> executed action, ledger entry, audit event, and
  updated managed state.
- Follow-up reminder -> trigger record and workflow intent.
- Autopilot constraints -> execution policy, permissions, limits, allowlists,
  denylists, cooldowns, and kill switches.

## DB Contract Mapping

The Personal Job Agent should not add app-specific framework primitives. It
should use the generic durable entities from `docs/db-contracts.md` and put
job-search-specific fields in `data`.

- `AgentRecord`: one configured job-search assistant for a user/workspace, with
  target roles, search cadence, writing style, and autonomy settings in `data`.
- `ThreadRecord`: conversations such as "apply to senior frontend roles this
  week", "why did you skip Acme?", or "prep me for tomorrow's interview".
- `WorkflowIntentRecord`: typed work like `job.discover`, `job.analyze_fit`,
  `application.prepare`, `application.dry_run`, `application.submit`,
  `followup.schedule`, or `outcome.review`.
- `RunRecord`: foreground chats, scheduled searches, browser automation runs,
  application attempts, follow-up checks, and child workflows with status,
  heartbeat, cancellation, and recovery metadata.
- `DecisionRecordEntity`: fit judgments, skip rationale, tailored positioning,
  risk notes, missing-information decisions, and superseded application
  strategies.
- `ManagedStateRecord`: opportunities, companies, application statuses,
  profile versions, application packets, interviews, follow-ups, preferences,
  constraints, and blocked requirements.
- `LedgerEntryRecord`: discovered jobs, skipped jobs, queued applications,
  drafted packets, dry-run submissions, executed submissions, blocked actions,
  responses, follow-ups, interviews, and outcomes.
- `TriggerRecord`: scheduled discovery, follow-up reminders, status refreshes,
  inbox or calendar wakeups, and job-board change monitors.
- `ToolMetadataRecord`: job-board search tools, company-site browser tools,
  resume/profile generators, form-fill tools, submission tools, inbox parsers,
  calendar tools, and artifact capture tools.
- `ToolPermissionRecord`: per-user enablement for read-only browsing,
  extraction, draft generation, dry-run form filling, live submission,
  email/calendar access, and follow-up sending.
- `ToolCallRecord`: every search, page extraction, browser step, resume draft,
  form dry-run, submission attempt, inbox read, and follow-up action.
- `ArtifactMetadataRecord`: extracted job snapshots, screenshots, application
  packets, generated answers, resume variants, confirmation receipts, email
  drafts, traces, and exported reports.
- `AuditEventRecord`: trigger wakeups, tool calls, policy blocks, approvals,
  submissions, follow-up attempts, manual overrides, and kill-switch events.

Example `data` fields:

- Opportunity managed state: `company`, `title`, `location`, `remotePolicy`,
  `compensation`, `sourceUrl`, `applicationUrl`, `deadline`, `status`,
  `discoveredAt`.
- Application packet: `opportunityId`, `profileVersionId`, `resumeArtifactId`,
  `coverLetterArtifactId`, `answersArtifactId`, `positioningSummary`.
- Application ledger entry: `opportunityId`, `executionMode`, `status`,
  `submittedAt`, `confirmationArtifactId`, `blockedReason`.
- Fit decision: `opportunityId`, `fitScore`, `confidence`,
  `supportingEvidence`, `counterEvidence`, `missingInformation`, `freshness`.
- Preference managed state: `roleFamilies`, `seniority`, `locations`,
  `salaryFloor`, `remotePolicy`, `companyAllowlists`, `companyDenylists`.

## Generic Workflow Lifecycle

The Personal Job Agent maps to the generic lifecycle:

```txt
discover jobs -> analyze fit -> prepare application -> submit or queue -> track outcomes -> follow up
```

The same shape applies to other browser-heavy work:

```txt
discover forms -> analyze requirements -> prepare packet -> submit or queue -> track status -> follow up
```

```txt
observe opportunities -> analyze fit -> propose action -> execute action -> review outcome
```

The lifecycle is intentionally generic. Job search is a stress test for
browser automation, personal data handling, and policy-controlled external
mutation.

## Tooling Requirement

Personal Job Agent tools should be server-side only. Browser code may request,
approve, inspect, or configure work, but resumes, profile data, job-board
credentials, email tokens, calendar tokens, and applicant-system credentials
must never reach the frontend.

The first useful adapter family should support browsing, extraction, packet
drafting, artifact capture, and dry-run form filling. Live application
submission tools must support `ask`, `dry_run`, and `execute`, with policy
checks outside the model.

Mutation-capable tools should not execute just because the model chooses to
apply. Execution requires user/workspace policy that defines:

- Role, seniority, location, remote, compensation, and company constraints.
- Allowlists, denylists, and blocked application classes.
- Rate limits, cooldowns, max runtime, and max child-run depth.
- Required review or approval rules for specific jobs or application fields.
- Credential availability, revocation state, and secret-scope checks.
- Kill switches for the workspace, tool family, and live submission.
- Audit, artifact, and redaction behavior for every attempt.

If a site cannot be dry-run safely, the adapter must document that limitation
and keep live submission disabled until policy explicitly allows it.

## Autopilot Boundary

Full autopilot is a target capability, not a shortcut around the framework
boundary. A production-ready autopilot should be able to submit matching jobs
inside configured policy without per-application approval, but only after the
platform has:

- Authenticated user/workspace identity.
- Encrypted, scoped, revocable secret custody.
- Tool permission records for browsing, extraction, packet generation, and
  submission.
- Dry-run paths for application classes where dry-run is technically possible.
- Approval gates where policy requires them.
- Durable ledgers for proposed, skipped, blocked, dry-run, and executed
  applications.
- Audit events, artifacts, redaction, limits, and kill switches.
- Tenant isolation tests that prove one user's search cannot touch another
  user's data, credentials, applications, or artifacts.

Until those controls exist, the production-safe behavior is browse, extract,
analyze, draft, dry-run, and queue for approval or later execution.

## Acceptance Scenarios

- Two users can run separate job agents with separate profiles, preferences,
  applications, tools, credentials, artifacts, schedules, and audit trails.
- A scheduled discovery run finds jobs, extracts structured records, stores
  source provenance, and updates managed state.
- The agent can explain why it ranked, skipped, queued, or applied to a role
  using decision records and artifacts.
- The agent can prepare an application packet and dry-run a complex form
  without submitting it.
- A live application submission creates tool calls, artifacts, ledger entries,
  managed-state updates, and audit events.
- A policy block prevents an application that violates compensation, location,
  company, rate-limit, missing-information, or kill-switch constraints.
- A follow-up trigger wakes the correct user/workspace agent and creates or
  resumes the right thread.
- The user can ask "what are you doing today?" and receive an answer grounded
  in managed state, current runs, ledgers, decisions, triggers, and recent tool
  calls.
- Frontend code cannot access credentials, private profile data beyond scoped
  display needs, raw browser secrets, or unredacted artifacts.
- Fly staging can show job state, application history, browser artifacts, tool
  history, trigger behavior, and policy blocks without live submissions enabled
  by default.

## Boundary

The Personal Job Agent is a reference mapping, not a special-case runtime. Its
browser tools, applications, ledgers, triggers, managed state, decision records,
and audit events must use the same operloom contracts as Polymancer,
deployment agents, and future reference apps.
