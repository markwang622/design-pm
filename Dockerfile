# syntax=docker/dockerfile:1
# ── Design-PM · Zeabur-ready Docker image (v3.3) ──────────────
# Build:   docker build -t design-pm:v3.3 .
# Run:     docker run -p 3000:3000 --env-file .env design-pm:v3.3
# Zeabur:  works out-of-the-box. If zbpack.json is also present,
#          Zeabur prefers Dockerfile, so this image must stay
#          functionally equivalent.
# ────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl  # required by Prisma
COPY package.json ./
COPY prisma ./prisma
# Install all deps (incl. dev) so prisma CLI is available.
# Use `npm install` (not `npm ci`) because we don't ship a
# package-lock.json; npm will resolve & cache versions itself.
RUN npm install --include=dev --no-audit --no-fund
RUN npx prisma generate

FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production
ENV PORT=3000

# Copy deps + generated Prisma client
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma

# Copy app
COPY package.json ./
COPY src ./src
COPY public ./public

EXPOSE 3000

# Startup sequence:
# 1. Sync DB schema (creates tables on first run, idempotent)
# 2. Seed (idempotent — no-op if DB already populated)
# 3. Start server
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && node prisma/seed.js && node src/index.js"]
