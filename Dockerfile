# ── Production image (ECS Fargate) ───────────────────────────────────────────
#   docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD) -t ew-account-service-api .

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: production dependencies only ────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    LOG_FORMAT=json
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Shown on /health as <version>+<short commit>
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=${GIT_COMMIT}

# Internal-only component: non-root user on 8080 (Developers Guide: Ports and exposure)
USER node
EXPOSE 8080

# node:22-alpine has no curl: health check with Node itself
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# exec form: node is PID 1 and receives SIGTERM directly (graceful shutdown)
CMD ["node", "dist/index.js"]
