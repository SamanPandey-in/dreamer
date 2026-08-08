-- AlterEnum
ALTER TYPE "DeploymentStatus" ADD VALUE 'LAUNCHING';

-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "cancelRequested" BOOLEAN NOT NULL DEFAULT false;

-- Extends the state machine (see the original function in add_log_fts and
-- its extend_stop_transitions revision) with LAUNCHING:
--   QUEUED    -> LAUNCHING is the new atomic claim step (was previously a
--                direct QUEUED -> BUILDING once build-engine's own task
--                self-reported it had started; that's now LAUNCHING -> BUILDING).
--   LAUNCHING -> BUILDING   normal path: the ECS task launched fine and is
--                           now reporting its own status like always.
--   LAUNCHING -> FAILED     the launch attempt(s) exhausted retries.
--   LAUNCHING -> STOPPED    cancelRequested was set AND an ECS task ARN did
--                           end up existing — build.worker.ts stopped it.
--   LAUNCHING -> CANCELLED  cancelRequested was set AND the launch failed
--                           anyway — nothing ever actually ran on AWS.
-- Every transition the previous version allowed is still allowed —
-- this is purely additive, same as extend_stop_transitions was.
CREATE OR REPLACE FUNCTION check_deployment_status_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.status = 'QUEUED' AND NEW.status NOT IN ('LAUNCHING', 'CANCELLED', 'FAILED')) OR
     (OLD.status = 'LAUNCHING' AND NEW.status NOT IN ('BUILDING', 'FAILED', 'STOPPED', 'CANCELLED')) OR
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

-- how to run this migration:
-- npx prisma db execute --file "prisma/migrations/20260808064743_add_launching_status/migration.sql"
-- npx prisma migrate status
