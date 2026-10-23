# syntax=docker/dockerfile:1
# Node24 LTS security release; deps and runtime use the same tested image.
ARG NODE_IMAGE=node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --include=dev --no-audit --no-fund

# Build explicitly with --target test to run offline regression suites on Node24.
FROM deps AS test
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY tests ./tests
ENV NODE_ENV=test
RUN npm test

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
RUN apk add --no-cache openssl postgresql18-client
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
EXPOSE 3000
# Existing databases must be explicitly baselined after verified backup/restore.
# No db push, data-loss acceptance, automatic bootstrap or sample seed on restart.
CMD ["sh", "-c", "node scripts/database-maintenance.mjs deploy && exec node src/index.js"]
