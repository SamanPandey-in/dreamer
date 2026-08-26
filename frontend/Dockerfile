FROM node:22-alpine AS base
WORKDIR /home/app

FROM base AS deps
COPY package*.json ./
RUN npm ci

FROM base AS builder
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
ARG NEXT_PUBLIC_SOCKET_URL=http://localhost:8000
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_SOCKET_URL=$NEXT_PUBLIC_SOCKET_URL
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /home/app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=deps /home/app/node_modules ./node_modules
COPY --from=builder /home/app/.next ./.next
COPY --from=builder /home/app/public ./public
COPY --from=builder /home/app/package.json ./package.json

USER nextjs
EXPOSE 3000
CMD ["npm", "start"]
