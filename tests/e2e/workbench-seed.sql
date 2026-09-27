-- Identity, workspace, membership, agent, and active preferences are intentionally
-- absent. The first local API request as e2e-owner bootstraps account
-- local-api:e2e-owner with the default workspace and agent ids used below.

INSERT INTO control_workflow_intents (
  id, user_id, workspace_id, agent_id, stage, type, execution_json, payload_json,
  status, created_at, updated_at
)
VALUES (
  'e2e-retry-intent',
  'e2e-owner',
  'workspace:local-api:e2e-owner:default',
  'agent-workspace:local-api:e2e-owner:default',
  'failed',
  'polymancer.market_research',
  '{"mode":"dry_run"}',
  '{"market":"Will the release pass?","maxMarkets":5}',
  'failed',
  '2026-07-09T20:05:00.000Z',
  '2026-07-09T20:05:00.000Z'
);

INSERT INTO control_workflow_intents (
  id, user_id, workspace_id, agent_id, stage, type, execution_json, payload_json,
  status, created_at, updated_at
)
VALUES (
  'e2e-approval-intent', 'e2e-owner', 'workspace:local-api:e2e-owner:default',
  'agent-workspace:local-api:e2e-owner:default', 'observe',
  'tool.url.inspect', '{"mode":"dry_run","policy":"url.inspect.public-read.v1"}',
  '{"input":{"url":"https://example.com"}}', 'interrupted',
  '2026-07-09T20:06:00.000Z', '2026-07-09T20:06:00.000Z'
);

INSERT INTO control_runs (
  id, user_id, workspace_id, agent_id, workflow_intent_id, status, execution_json,
  stage, engine, heartbeat_at, last_event_at, completed_at, failed_at, cancelled_at,
  data_json, created_at, updated_at
)
VALUES (
  'e2e-approval-run', 'e2e-owner', 'workspace:local-api:e2e-owner:default',
  'agent-workspace:local-api:e2e-owner:default',
  'e2e-approval-intent', 'interrupted',
  '{"mode":"dry_run","policy":"url.inspect.public-read.v1"}', 'observe', 'cloudflare',
  '2026-07-09T20:06:00.000Z', '2026-07-09T20:06:00.000Z', NULL, NULL, NULL,
  '{"displayName":"Approval recovery fixture","summary":"Waiting for operator approval."}',
  '2026-07-09T20:06:00.000Z', '2026-07-09T20:06:00.000Z'
);

INSERT INTO control_approval_requests (
  id, user_id, workspace_id, agent_id, workflow_intent_id, run_id, tool_id, status,
  reason, data_json, created_at, updated_at
)
VALUES (
  'e2e-approval', 'e2e-owner', 'workspace:local-api:e2e-owner:default',
  'agent-workspace:local-api:e2e-owner:default',
  'e2e-approval-intent', 'e2e-approval-run', 'url.inspect', 'requested',
  'Confirm public URL inspection.',
  '{"input":{"url":"https://example.com"},"runner":{"transport":"fly"}}',
  '2026-07-09T20:06:00.000Z', '2026-07-09T20:06:00.000Z'
);

INSERT INTO control_runs (
  id, user_id, workspace_id, agent_id, workflow_intent_id, status, execution_json,
  stage, engine, heartbeat_at, last_event_at, completed_at, failed_at, data_json,
  created_at, updated_at
)
VALUES (
  'e2e-retry-run',
  'e2e-owner',
  'workspace:local-api:e2e-owner:default',
  'agent-workspace:local-api:e2e-owner:default',
  'e2e-retry-intent',
  'failed',
  '{"mode":"dry_run"}',
  'failed',
  'cloudflare',
  NULL,
  '2026-07-09T20:05:00.000Z',
  NULL,
  '2026-07-09T20:05:00.000Z',
  '{"displayName":"Release recovery fixture","summary":"A failed retryable run used to verify normal-surface recovery controls."}',
  '2026-07-09T20:05:00.000Z',
  '2026-07-09T20:05:00.000Z'
);

INSERT INTO control_operator_alerts (
  id, user_id, workspace_id, agent_id, severity, code, summary, target_type,
  target_id, status, dedup_key, delivery_status, delivery_attempts,
  last_delivery_at, data_json, created_at, updated_at
)
VALUES (
  'e2e-operator-alert', 'e2e-owner', 'workspace:local-api:e2e-owner:default',
  'agent-workspace:local-api:e2e-owner:default', 'critical',
  'level3_soak_fixture', 'A deterministic unattended failure requires operator recovery.',
  'triggerDispatch', 'e2e-trigger-dispatch', 'open',
  'e2e:operator-alert:level3-soak-fixture', 'failed', 5,
  '2026-07-09T20:07:00.000Z', '{"fixture":true}',
  '2026-07-09T20:07:00.000Z', '2026-07-09T20:07:00.000Z'
);

INSERT INTO control_action_proposals (
  id, user_id, workspace_id, agent_id, workflow_intent_id, run_id, pack_id,
  pack_version, runtime_version, binding_version, tool_id, action_type, status,
  summary, idempotency_key, input_sha256, proposal_json, external_reference,
  result_json, created_at, updated_at, terminal_at
)
VALUES (
  'e2e-action-proposal', 'e2e-owner', 'workspace:local-api:e2e-owner:default',
  'agent-workspace:local-api:e2e-owner:default', 'e2e-retry-intent', 'e2e-retry-run', 'complex-operator', '1.1.0', '1.1.0', 1,
  'operator.action.execute', 'synthetic.external_action', 'executed',
  'Synthetic release action completed after approval.', 'e2e-release-action',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '{"operation":"synthetic-release-check","dryRun":true}', 'synthetic-action-001',
  '{"ok":true,"synthetic":true}', '2026-07-09T20:08:00.000Z',
  '2026-07-09T20:08:02.000Z', '2026-07-09T20:08:02.000Z'
);

INSERT INTO control_action_ledger (
  id, user_id, workspace_id, agent_id, proposal_id, sequence, status, summary,
  request_sha256, response_sha256, external_reference, data_json, created_at
)
VALUES
  ('e2e-action-ledger-1', 'e2e-owner', 'workspace:local-api:e2e-owner:default',
   'agent-workspace:local-api:e2e-owner:default',
   'e2e-action-proposal', 1, 'proposed', 'Synthetic action proposed.',
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NULL, NULL,
   '{"fixture":true}', '2026-07-09T20:08:00.000Z'),
  ('e2e-action-ledger-2', 'e2e-owner', 'workspace:local-api:e2e-owner:default',
   'agent-workspace:local-api:e2e-owner:default',
   'e2e-action-proposal', 2, 'executed', 'Synthetic provider accepted the action once.',
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
   'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
   'synthetic-action-001', '{"fixture":true}', '2026-07-09T20:08:02.000Z');
