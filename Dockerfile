FROM node:24-slim AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy all workspace files needed for install + build
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY tsconfig*.json ./
COPY lib/ ./lib/
COPY artifacts/api-server/ ./artifacts/api-server/

# Install all deps (CI=true bypasses preinstall guard & minimumReleaseAge)
ENV CI=true
RUN pnpm install --frozen-lockfile --ignore-scripts

# Build the api-server package
RUN pnpm --filter "@workspace/api-server" run build

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:24-slim

WORKDIR /app

# Copy built output and node_modules from builder
COPY --from=builder /app/artifacts/api-server/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/artifacts/api-server/node_modules ./artifacts/api-server/node_modules 2>/dev/null || true

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
