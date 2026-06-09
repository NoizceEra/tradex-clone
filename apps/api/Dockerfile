# syntax=docker/dockerfile:1
FROM node:20-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Copy manifests first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/ ./packages/

# Install all deps (workspace-aware)
RUN pnpm install --frozen-lockfile

# Copy full source
COPY . .

WORKDIR /app/apps/api

EXPOSE 4000
ENV HOST=0.0.0.0
ENV PORT=4000
ENV NODE_ENV=production

CMD ["pnpm", "start"]
