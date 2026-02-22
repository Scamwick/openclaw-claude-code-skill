# ─── Build Stage ──────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Copy dependency manifests first for Docker layer caching
COPY package.json package-lock.json* ./

# Install all dependencies (including devDependencies for tsc)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript
RUN npx tsc

# ─── Runtime Stage ────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

LABEL maintainer="codyshort"
LABEL description="claude-code-skill backend server"

# Install curl for health checks and install Claude CLI
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install Claude CLI globally
RUN npm install -g @anthropic-ai/claude-code || true

WORKDIR /app

# Copy dependency manifests and install production-only deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from builder
COPY --from=builder /app/dist/ ./dist/

# Create non-root user
RUN groupadd --gid 1001 appuser && \
    useradd --uid 1001 --gid 1001 --create-home appuser && \
    chown -R appuser:appuser /app

USER appuser

# Server configuration
ENV CLAUDE_CODE_PORT=18795
ENV CLAUDE_CODE_HOST=0.0.0.0
ENV NODE_ENV=production

EXPOSE 18795

# Health check: hit the API prefix root (expects 404 with JSON body, proving server is up)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:18795/backend-api/claude-code/tools || exit 1

CMD ["node", "dist/server.js"]
