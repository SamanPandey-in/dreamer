# Generated Dockerfile for a NEXT_SSR project that doesn't ship its own.
# Two-stage build: builder installs+builds, runner ships just the
# standalone output and runs the Next.js server directly as a plain
# long-lived container.
#
# Requires the target repo's next.config.js to set `output: 'standalone'`
# — see dockerfile-resolver.js's warnIfNotStandalone for the check and
# warning if it's missing.
FROM node:22-slim AS builder
WORKDIR /app
COPY . .

# The build-args placeholder below is replaced with one ARG + ENV pair
# per configured env var name (values come in separately as `docker
# build --build-arg`s, never written into this file — see
# docker-build.js). Must sit before install/build so NEXT_PUBLIC_* vars
# and any other build-time process.env reads are actually available
# when `next build` runs below. Empty string, i.e. no lines, when the
# project has no env vars configured.
__BUILD_ARGS__RUN __INSTALL_COMMAND__
RUN __BUILD_COMMAND__

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
CMD ["node", "server.js"]
