FROM node:24-slim AS builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY tsconfig*.json ./
COPY lib/ ./lib/
COPY artifacts/api-server/ ./artifacts/api-server/
ENV CI=true
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter "@workspace/api-server" run build

FROM node:24-slim
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/artifacts/api-server/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/lib ./lib
ENV NODE_ENV=production
ENV PORT=8080
CMD ["node", "--enable-source-maps", "./dist/index.mjs"]