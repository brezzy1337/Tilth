# syntax=docker/dockerfile:1
#
# HomeGrown server image
# Build context: repo root  (docker build -f infra/Dockerfile .)
# Target platform: linux/amd64 (GCP Cloud Run)
#
# The builder stage installs deps and runs esbuild to produce a single
# self-contained ESM bundle at apps/server/dist/index.mjs. The runtime
# stage carries only Node + that one file — no tsx, no esbuild, no node_modules.
#
# NO SECRETS. Secrets (DATABASE_URL, Stripe keys, etc.) are injected at deploy
# time via GCP Secret Manager → Cloud Run env vars. Never bake a value here.

# Pin to a specific digest for full reproducibility.
# node:22.16.0-slim  (linux/amd64) — update the digest when you intentionally
# upgrade the base image; CI will reject an unreviewed digest change.
FROM node:22.16.0-slim@sha256:1471ea646673136b8308550ac14b36d847ffb21c24bc31828279e443c924e488 AS builder

# ── pnpm via corepack ───────────────────────────────────────────────────────
# Pin to the same version declared in root package.json (packageManager field).
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# ── Workspace skeleton ──────────────────────────────────────────────────────
# Copy manifests first so the install layer is cached independently of source.
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# Workspace package manifests (no source yet — install cache layer)
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/server/package.json      ./apps/server/package.json

# ── Install ─────────────────────────────────────────────────────────────────
# --frozen-lockfile: committed pnpm-lock.yaml is authoritative; fail if drift.
# ignore-scripts=true is set in .npmrc, but root package.json's
# pnpm.onlyBuiltDependencies allowlist permits esbuild's postinstall so its
# prebuilt linux-x64 binary is fetched (no native compilation needed).
# --filter keeps install scoped to the server and its workspace deps.
RUN pnpm install --frozen-lockfile --filter @homegrown/server...

# ── Application source ──────────────────────────────────────────────────────
COPY packages/shared/ ./packages/shared/
COPY apps/server/     ./apps/server/

# ── Bundle ──────────────────────────────────────────────────────────────────
# Produces apps/server/dist/index.mjs — a single self-contained ESM file that
# includes @homegrown/shared and all third-party deps. Plain `node` can run it.
RUN pnpm --filter @homegrown/server build
# Produces apps/server/dist/reconcile.mjs — the Cloud Run Job entrypoint.
# Same image carries both bundles; the Job overrides CMD to `node /app/reconcile.mjs`.
RUN pnpm --filter @homegrown/server build:reconcile

# ── Runtime stage ───────────────────────────────────────────────────────────
FROM node:22.16.0-slim@sha256:1471ea646673136b8308550ac14b36d847ffb21c24bc31828279e443c924e488 AS runtime

# ca-certificates: required for TLS connections to Cloud SQL (Postgres) and
# Stripe's API. Must be in the runtime image even though build tools are not.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Cloud Run injects PORT (typically 8080). The server reads it via env.ts and
# defaults to 3001 locally — do NOT hardcode a value here.
# DATABASE_URL and other secrets are injected at deploy time via Secret Manager.
ENV NODE_ENV=production

WORKDIR /app

# Copy both bundled files from the builder.
# index.mjs   → started by the Cloud Run Service CMD below.
# reconcile.mjs → started by the Cloud Run Job (command override: node /app/reconcile.mjs).
COPY --from=builder /app/apps/server/dist/index.mjs /app/index.mjs
COPY --from=builder /app/apps/server/dist/reconcile.mjs /app/reconcile.mjs

# Expose is documentation only; Cloud Run binds whatever PORT it injects.
EXPOSE 8080

# Non-root user for defence-in-depth.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 --ingroup nodejs server
USER server

CMD ["node", "/app/index.mjs"]
