# syntax=docker/dockerfile:1
# ── Design-PM · Zeabur-ready Docker image ─────────────────────
# Build:   docker build -t design-pm:v3.2 .
# Run:     docker run -p 3000:3000 --env-file .env design-pm:v3.2
# Zeabur:  works out-of-the-box if zbpack.json is absent or if you
#          choose "Docker" as the build mode.
# ────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl  # required by Prisma
COPY package.json package-lock.json* ./
COPY prisma ./prisma
# Install all deps (incl. dev) so prisma generate works
RUN npm ci --include=dev

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
# 1. Run any pending migrations
# 2. Seed (idempotent — no-op if DB already populated)
# 3. Start server
CMD ["sh", "-c", "npx prisma migrate deploy && node prisma/seed.js && node src/index.js"]
