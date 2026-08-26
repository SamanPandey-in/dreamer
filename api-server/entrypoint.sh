#!/bin/sh
set -e

# Only the api-server container runs migrations — build-worker shares this
# same image/entrypoint (docker-compose.yml only overrides its `command`,
# not its entrypoint), so without this guard both containers would race to
# run `prisma migrate deploy` concurrently and one would time out waiting
# on the other's advisory lock.
if [ "$RUN_MIGRATIONS" = "true" ]; then
  echo "Running migrations..."
  npx prisma generate
  # migrate deploy ONLY — migrate dev is an interactive, dev-only command.
  # In a non-interactive container it can hang waiting on stdin (or need a
  # shadow DB it has no privileges for), holding the advisory lock forever
  # and causing exactly the P1002 timeout you hit.
  npx prisma migrate deploy
  echo "Migrations complete."
else
  npx prisma generate
fi

echo "Starting application..."
exec "$@"
