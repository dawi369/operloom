-- The outreach cap counts an agent's receipts for one operation per day; the scope index is keyed by user.
CREATE INDEX idx_provider_operations_outreach
  ON control_provider_operations (workspace_id, agent_id, operation_id, status, created_at);
