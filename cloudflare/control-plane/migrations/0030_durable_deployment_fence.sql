-- Platform deployment metadata, containing no tenant payloads. A non-expiring
-- admission fence closes the scan/deploy race, including old Worker admissions.
-- Existing executions and exact submission replays remain usable while fenced.
CREATE TABLE control_durable_deployment_fence (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 deployment_id TEXT NOT NULL,
 artifact_sha256 TEXT NOT NULL CHECK(length(artifact_sha256)=64),
 acquired_at TEXT NOT NULL,
 activate_on_release INTEGER NOT NULL DEFAULT 0 CHECK(activate_on_release IN (0,1))
);
ALTER TABLE control_durable_executions ADD COLUMN deployment_id TEXT NOT NULL DEFAULT '';
CREATE TABLE control_durable_deployment_generation (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 deployment_id TEXT NOT NULL,
 artifact_sha256 TEXT NOT NULL
);
-- Activation and releasing admissions are one atomic database statement.
CREATE TRIGGER durable_deployment_activate AFTER UPDATE OF activate_on_release ON control_durable_deployment_fence
WHEN NEW.activate_on_release=1
BEGIN
 INSERT OR REPLACE INTO control_durable_deployment_generation (singleton,deployment_id,artifact_sha256)
 VALUES (1,NEW.deployment_id,NEW.artifact_sha256);
 DELETE FROM control_durable_deployment_fence WHERE singleton=1 AND deployment_id=NEW.deployment_id;
END;
CREATE TRIGGER durable_deployment_admission_fence BEFORE INSERT ON control_durable_executions
WHEN EXISTS (SELECT 1 FROM control_durable_deployment_fence WHERE singleton=1)
BEGIN SELECT RAISE(ABORT,'durable_deployment_in_progress'); END;
CREATE TRIGGER durable_deployment_stale_worker BEFORE INSERT ON control_durable_executions
WHEN EXISTS (SELECT 1 FROM control_durable_deployment_generation WHERE singleton=1 AND deployment_id!=NEW.deployment_id)
BEGIN SELECT RAISE(ABORT,'durable_deployment_changed'); END;
CREATE TRIGGER durable_deployment_pin_immutable BEFORE UPDATE OF deployment_id ON control_durable_executions
WHEN NEW.deployment_id!=OLD.deployment_id
BEGIN SELECT RAISE(ABORT,'durable_deployment_pin_immutable'); END;
