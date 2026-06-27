-- Add tsvector column for full-text search
ALTER TABLE "DeploymentLog" ADD COLUMN ts_message tsvector
  GENERATED ALWAYS AS (to_tsvector('english', message)) STORED;

CREATE INDEX idx_deployment_log_fts 
  ON "DeploymentLog" USING GIN (ts_message);


-- Deployment sequence counter (for log ordering):

-- Atomic sequence per deployment — ensures log lines are always ordered correctly
-- even when multiple publish calls happen in the same millisecond

CREATE SEQUENCE deployment_log_seq START 1;

-- Function to get-and-increment per deployment
CREATE OR REPLACE FUNCTION next_log_sequence(dep_id UUID) RETURNS INT AS $$
  SELECT nextval('deployment_log_seq_' || replace(dep_id::text, '-', '_'));
$$ LANGUAGE SQL;


-- Enforce state machine at DB level:

-- Only allow valid status transitions
-- Prevents application bugs from corrupting deployment state

CREATE OR REPLACE FUNCTION check_deployment_status_transition()
RETURNS TRIGGER AS $$
BEGIN
  -- Define valid transitions
  IF (OLD.status = 'QUEUED' AND NEW.status NOT IN ('BUILDING', 'CANCELLED', 'FAILED')) OR
     (OLD.status = 'BUILDING' AND NEW.status NOT IN ('UPLOADING', 'STARTING', 'RUNNING', 'FAILED')) OR
     (OLD.status = 'UPLOADING' AND NEW.status NOT IN ('RUNNING', 'FAILED')) OR
     (OLD.status = 'STARTING' AND NEW.status NOT IN ('RUNNING', 'FAILED')) OR
     (OLD.status = 'RUNNING' AND NEW.status NOT IN ('SLEEPING', 'STOPPED', 'FAILED')) OR
     (OLD.status = 'SLEEPING' AND NEW.status NOT IN ('WAKING', 'STOPPED')) OR
     (OLD.status = 'WAKING' AND NEW.status NOT IN ('RUNNING', 'FAILED', 'STOPPED')) OR
     (OLD.status IN ('STOPPED', 'FAILED', 'CANCELLED') AND OLD.status != NEW.status)
  THEN
    RAISE EXCEPTION 'Invalid deployment status transition from % to %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_deployment_status_transition
  BEFORE UPDATE OF status ON "Deployment"
  FOR EACH ROW EXECUTE FUNCTION check_deployment_status_transition();


-- Composite partial index for the idle detector:

-- The idle detection job runs: 
-- SELECT * FROM "Deployment" WHERE status = 'RUNNING' AND type = 'DYNAMIC'
-- This partial index covers exactly that query at O(active_dynamic_deployments) not O(all_deployments)

CREATE INDEX idx_deployment_active_dynamic
  ON "Deployment" (status, "lastRequestAt")
  WHERE status = 'RUNNING' AND type = 'DYNAMIC';

-- how to run this migration:
-- npx prisma db execute --file "prisma/migrations/20260626095933_add_log_fts/migration.sql"
-- npx prisma migrate resolve --applied 20260626095933_add_log_fts
-- check status
-- npx prisma migrate status