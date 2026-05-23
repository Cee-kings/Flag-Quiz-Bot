FROM node:24-slim
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY tsconfig*.json ./
COPY lib/ ./lib/
COPY artifacts/api-server/ ./artifacts/api-server/
ENV CI=true
RUN pnpm install --frozen-lockfile --ignore-scripts --shamefully-hoist
RUN pnpm --filter "@workspace/api-server" run build
ENV NODE_ENV=production
ENV PORT=8080
CMD ["node", "--enable-source-maps", "./artifacts/api-server/dist/index.mjs"]