ALTER TABLE control_action_proposals ADD COLUMN approval_decision TEXT CHECK (approval_decision IN ('auto', 'review'));
ALTER TABLE control_action_proposals ADD COLUMN approval_evidence TEXT NOT NULL DEFAULT '{}';
ALTER TABLE control_action_proposals ADD COLUMN reviewed_at TEXT;
