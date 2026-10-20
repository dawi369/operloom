-- Fleet reads an agent's latest events across the workspace; the existing index is keyed by user.
CREATE INDEX idx_control_plane_events_agent_latest
  ON control_plane_events (workspace_id, agent_id, created_at DESC, id DESC);
