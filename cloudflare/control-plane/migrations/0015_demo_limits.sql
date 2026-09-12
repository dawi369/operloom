CREATE TABLE control_demo_daily_usage (
  user_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  chat_count INTEGER NOT NULL DEFAULT 0,
  workflow_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, usage_date)
);

CREATE TABLE control_demo_budget_alerts (
  usage_month TEXT NOT NULL,
  threshold_percent INTEGER NOT NULL,
  usage_usd REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (usage_month, threshold_percent)
);
