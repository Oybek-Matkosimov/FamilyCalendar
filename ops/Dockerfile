# syntax=docker/dockerfile:1
# Targets:
#   runner  (default)  the web app (Next.js standalone output), runs as a non-root user
#   migrate            one-shot job that applies database migrations, then exits

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
# Allow Node to use more memory while building (small servers rely on swap space); the default limit is ~430 MB here.
ENV NODE_OPTIONS=--max-old-space-size=2048
RUN npm run build
ENV NODE_OPTIONS=

FROM deps AS migrate
ENV NODE_ENV=production
COPY tsconfig.json ./
COPY src ./src
CMD ["npx", "tsx", "src/server/db/migrate.ts"]

FROM base AS runner
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app --no-create-home app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
# SQL migrations are read from disk at start-up when AUTO_MIGRATE=true
COPY --from=build --chown=app:app /app/src/server/db/migrations ./src/server/db/migrations
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
