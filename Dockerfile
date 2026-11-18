# syntax=docker/dockerfile:1.7
#
# Three images from one build (docs/DEPLOYMENT.md):
#   app  — the web app: Next.js standalone server only (small, no dev tools, no sources)
#   ops  — migrations and scheduled jobs: full dependencies + scripts (npm run db:migrate / db:stock / seed)
# The backup image is separate (deploy/backup/Dockerfile): it needs pg_dump, not Node.
#
#   docker build --target app -t velza-app .
#   docker build --target ops -t velza-ops .

ARG NODE_IMAGE=node:24-bookworm-slim

# ---------------------------------------------------------------- dependencies (dev included: tsx, the build)
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------- build
FROM deps AS build
# Security headers (HSTS, upgrade-insecure-requests) are fixed at build time in a standalone build
# (next.config.ts reads HTTPS_ONLY). Every deployed environment is served over HTTPS by Caddy.
ARG HTTPS_ONLY=1
ENV HTTPS_ONLY=${HTTPS_ONLY} NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm run build

# ---------------------------------------------------------------- AWS database certificates
# Managed PostgreSQL on AWS (Lightsail / RDS) presents certificates signed by the AWS RDS CAs. node-postgres treats
# sslmode=require as full verification, so the bundle must be present: DATABASE_URL ends with
#   ?sslmode=verify-full&sslrootcert=/etc/ssl/aws/rds-global-bundle.pem
FROM ${NODE_IMAGE} AS certs
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/aws/rds-global-bundle.pem

# ---------------------------------------------------------------- ops image
FROM ${NODE_IMAGE} AS ops
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=certs /etc/ssl/aws /etc/ssl/aws
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY db ./db
COPY deploy/jobs.sh ./deploy/jobs.sh
USER node
CMD ["sh", "deploy/jobs.sh"]

# ---------------------------------------------------------------- app image (last = default target)
FROM ${NODE_IMAGE} AS app
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 VELZA_UPLOAD_DIR=/data/uploads
COPY --from=certs /etc/ssl/aws /etc/ssl/aws
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
RUN mkdir -p /data/uploads && chown node:node /data/uploads
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
