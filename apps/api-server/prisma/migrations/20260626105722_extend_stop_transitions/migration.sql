-- Extends the deployment status state machine (originally defined in the
-- add_log_fts migration) to allow STOPPED as a valid target from the three
-- in-flight build states. The original trigger only allowed STOPPED from
-- RUNNING / SLEEPING / WAKING — meaning a user-initiated Stop on a deployment
-- that's still BUILDING, UPLOADING, or STARTING was previously impossible to
-- represent at all. QUEUED is deliberately left alone: a queued deployment
-- being stopped before a worker even picks it up already has a correct,
-- existing target — CANCELLED — and the application layer (deployment.service.ts,
-- Part 2) routes a Stop request on a QUEUED deployment there, not to STOPPED.
--
-- This is purely additive: every transition the original function allowed is
-- still allowed. Nothing here makes the state machine MORE permissive than it
-- needs to be — STOPPED is still rejected from QUEUED (use CANCELLED) and from
-- the three terminal states (STOPPED/FAILED/CANCELLED can't transition again at all).

CREATE OR REPLACE FUNCTION check_deployment_status_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.status = 'QUEUED' AND NEW.status NOT IN ('BUILDING', 'CANCELLED', 'FAILED')) OR
     (OLD.status = 'BUILDING' AND NEW.status NOT IN ('UPLOADING', 'STARTING', 'RUNNING', 'FAILED', 'STOPPED')) OR
     (OLD.status = 'UPLOADING' AND NEW.status NOT IN ('RUNNING', 'FAILED', 'STOPPED')) OR
     (OLD.status = 'STARTING' AND NEW.status NOT IN ('RUNNING', 'FAILED', 'STOPPED')) OR
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

-- The trigger itself doesn't need to be re-created — CREATE OR REPLACE FUNCTION
-- above swaps the function body the existing trigger already points at.

-- how to run this migration:
-- npx prisma db execute --file "prisma/migrations/20260626105722_extend_stop_transitions/migration.sql"
-- npx prisma migrate resolve --applied 20260626105722_extend_stop_transitions
-- check status
-- npx prisma migrate status