CREATE INDEX IF NOT EXISTS idx_deployment_log_fts 
  ON "DeploymentLog" USING GIN (ts_message);