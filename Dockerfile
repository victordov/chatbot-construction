# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: install production dependencies.
#
# bcrypt 6 ships prebuilt binaries (node_modules/bcrypt/prebuilds/linux-*/
# bcrypt.musl.node) and pdf-parse's only native dependency, @napi-rs/canvas,
# has a linux-*-musl package, so nothing here needs a compiler on Alpine.
# If a future dependency does, uncomment the apk line: the toolchain stays in
# this stage and never reaches the runtime image.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS deps

WORKDIR /app

# RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 2: bundle the dashboard.
#
# esbuild and the front-end libraries are dev dependencies: they are needed to
# produce public/dist and never at runtime, so they stay in this stage.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS client

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

COPY scripts/build-client.js scripts/build-client.js
COPY client client
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3: runtime.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000

# Whole-database backups (BACKUPS_ENABLED=true) shell out to `mongodump`.
# Per-tenant backups (TENANT_BACKUPS_ENABLED) do not need it. The package is
# ~100 MB, so it is not installed by default; enable it only if you use it.
# RUN apk add --no-cache mongodb-tools

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .
COPY --from=client /app/public/dist ./public/dist

# Everything the process writes at runtime lives under these three
# directories. They are created here so the non-root user owns them; mount a
# volume over uploads/ and backups/ so a redeploy does not lose them.
RUN mkdir -p logs uploads backups \
    && chown -R node:node /app

USER node

EXPOSE 3000

# /health is liveness only (200 whenever the process is up). Point an
# orchestrator's readiness probe at /ready, which returns 503 while MongoDB is
# unreachable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server.js"]
