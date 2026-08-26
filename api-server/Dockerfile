FROM node:22-alpine AS base
WORKDIR /home/app

FROM base AS deps
COPY package*.json ./
RUN npm ci
# COPY prisma ./prisma
# RUN npx prisma generate
# RUN npx prisma migrate deploy

FROM base AS runner
# DockerDeploymentEngine (lib/docker-engine.ts) shells out to the `docker`
# binary directly — mounting /var/run/docker.sock (docker-compose.yml)
# only exposes the daemon's socket, it does not put the CLI itself on
# PATH inside this alpine image. Without this, execFile('docker', ...)
# fails with ENOENT before it ever reaches the daemon, and every build
# job dies after its retries with no container ever created.
RUN apk add --no-cache docker-cli
COPY --from=deps /home/app/node_modules ./node_modules
# COPY --from=deps /home/app/prisma ./prisma
COPY . .
RUN apk add --no-cache docker-cli
RUN npx prisma generate

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["./entrypoint.sh"]
CMD ["npx", "tsx", "src/index.ts"]
