# Deployment Agent Reference App

A deployment agent is an operational reference target for operloom. It
proves the framework can support complex production work across domains.

## Vision

The deployment agent watches CI, deployments, services, incidents, and logs. A
user should be able to ask what failed, what changed, what the agent proposes,
whether a deploy is safe, and what happened after a rollback or rollout.

The agent should be conversational, stateful, auditable, and cautious around
mutation-capable tools. It can analyze and propose freely, dry-run operational
actions, and execute only through explicit policy-controlled paths.

## Why This Reference App Matters

Deployment work stresses the same generic framework primitives as other serious
agent projects:

- Long-running workflows: builds, deploys, rollbacks, and log reviews can outlive
  a single browser session.
- External triggers: CI failures, deploy webhooks, incident alerts, and uptime
  checks should wake the right workspace.
- Tools: GitHub, CI providers, logs, cloud CLIs, browser checks, and deploy APIs
  need a repeatable tool adapter path.
- Secrets: deploy tokens, cloud credentials, GitHub tokens, and incident tools
  must stay server-side and tenant-scoped.
- Ledgers and audit: proposed fixes, deploy attempts, rollbacks, skips, and
  manual overrides need durable records.
- Multi-user isolation: every workspace needs separate repos, tools, secrets,
  environments, policies, artifacts, and audit logs.

## Generic Workflow Lifecycle

Deployment maps to the same generic lifecycle:

```txt
observe CI -> analyze failure -> propose fix -> execute deploy -> review logs
```

Other operational variants use the same shape:

```txt
observe uptime -> analyze incident -> propose rollback -> execute rollback -> review recovery
```

```txt
observe logs -> analyze regression -> propose config change -> execute dry-run -> review diff
```

## DB Contract Mapping

The deployment agent should use the generic durable entities from
`docs/db-contracts.md` and put deployment-specific fields in `data`.

- `AgentRecord`: one configured deployment assistant for a workspace, with repo
  set, environments, review style, and operating cadence in `data`.
- `ThreadRecord`: conversations such as "why did staging fail?" or "review the
  production deploy".
- `WorkflowIntentRecord`: typed work like `ci.observe`, `failure.analyze`,
  `deploy.propose`, `deploy.execute`, `rollback.propose`, or `logs.review`.
- `RunRecord`: foreground investigations, CI-triggered analyses, deploy
  attempts, rollback reviews, and child workflow executions with status,
  heartbeat, cancellation, and recovery metadata.
- `DecisionRecordEntity`: root-cause hypotheses, deploy safety judgments,
  rollback rationale, and post-incident conclusions.
- `ManagedStateRecord`: repositories, services, environments, incidents,
  releases, deploy targets, and current health status.
- `LedgerEntryRecord`: proposed deploys, dry-run deploys, executed deploys,
  skipped actions, blocked actions, rollbacks, and post-deploy reviews.
- `TriggerRecord`: CI failure webhooks, deployment webhooks, uptime alerts,
  scheduled health checks, and incident-tool alerts.
- `ToolMetadataRecord`: GitHub tools, CI tools, log search tools, cloud deploy
  CLIs, browser smoke tools, and issue tracker adapters.
- `ToolPermissionRecord`: per-workspace enablement for read-only inspection,
  dry-run deploy previews, staging deploys, production deploys, and rollback
  tools.
- `ToolCallRecord`: each CI read, log query, GitHub API call, deploy dry-run,
  deploy execution, rollback attempt, and browser smoke run.
- `ArtifactMetadataRecord`: CI logs, deploy logs, smoke screenshots, diffs,
  rollback plans, traces, and postmortem reports.
- `AuditEventRecord`: trigger wakeups, tool calls, policy blocks, approvals,
  deploy attempts, rollbacks, and manual overrides.

Example `data` fields:

- Service managed state: `repo`, `serviceName`, `environment`, `currentVersion`,
  `desiredVersion`, `healthStatus`.
- CI failure decision: `repo`, `workflowName`, `runId`, `commitSha`,
  `suspectedCause`, `confidence`, `counterEvidence`.
- Deploy ledger entry: `repo`, `serviceName`, `environment`, `commitSha`,
  `deployStrategy`, `executionMode`, `rollbackPlan`.
- Trigger: `provider`, `eventName`, `repo`, `environment`, `externalRunId`.

## Tooling Requirement

Deployment tools should be server-side only. Browser code may request or approve
actions, but deploy credentials and tokens must never reach the frontend.

The first useful adapter family can be read-only: inspect CI, read logs, and
collect artifacts. Mutation-capable deploy and rollback tools must support
`ask`, `dry_run`, and `execute`, with policy checks outside the model.

## Acceptance Scenarios

- A CI failure webhook wakes the correct workspace and creates a workflow intent.
- The agent reads CI/log state and writes a decision record explaining the likely
  failure.
- The agent proposes a deploy or rollback in dry-run mode and records a ledger
  entry without mutating external systems.
- A production mutation pauses for approval, resumes after confirmation, and
  records audit events and artifacts.
- The user can ask "what happened and why?" and receive an answer grounded in
  managed state, decision records, tool calls, and logs.

## Boundary

The deployment agent is a reference mapping, not a special-case runtime. Its
tools, ledgers, triggers, managed state, and decision records must use the same
operloom contracts as Polymancer and future reference apps.
