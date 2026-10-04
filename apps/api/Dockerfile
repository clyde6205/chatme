# syntax=docker/dockerfile:1.7
# CHATme API: Fastify HTTP + WebSocket service.
# Build from the repository root (the API bundles workspace packages):
#   docker build -f apps/api/Dockerfile -t chatme-api .
# Runs on any container platform (Fly.io, AWS ECS/Fargate, Cloud Run, Kubernetes).

# Override to pull from a mirror, e.g. public.ecr.aws/docker/library/node:22-slim.
ARG NODE_IMAGE=node:22-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Manifests first so dependency installation is cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/i18n/package.json packages/i18n/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@chatme/api..."
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/i18n packages/i18n
COPY apps/api apps/api
RUN pnpm --filter @chatme/api build
# Production-only node_modules for the API (workspace packages are already bundled into dist).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @chatme/api deploy --prod --legacy /out && \
    rm -rf /out/src /out/test /out/*.config.ts /out/tsconfig.json

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 8080
# Fly.io uses the checks in fly.toml; this serves Docker, ECS and Kubernetes-style hosts.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# PID 1 is node itself so SIGTERM reaches the graceful shutdown handler directly.
CMD ["node", "--enable-source-maps", "dist/server.js"]
