FROM docker.io/library/node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS build
RUN npm install --global --no-fund --no-audit pnpm@12.17.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json release.config.json ./
COPY packages ./packages
COPY apps/dispatch ./apps/dispatch
COPY apps/dashboard ./apps/dashboard
RUN pnpm install --frozen-lockfile --filter @stationly/dashboard...
RUN pnpm --filter @stationly/dashboard exec vite build
RUN find . -name node_modules -type d -prune -exec rm -rf {} + \
 && find apps/dashboard -mindepth 1 -maxdepth 1 ! -name dist ! -name package.json -exec rm -rf {} + \
 && pnpm install --frozen-lockfile --prod --filter @stationly/dispatch... --filter @stationly/cli...

FROM docker.io/library/node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
ARG VERSION=0.0.0
ENV NODE_ENV=production STATIONLY_DISPATCH_VERSION=${VERSION}
COPY --from=build /app /app
RUN mkdir /data && chown node:node /data
USER node
WORKDIR /app/apps/dispatch
ENTRYPOINT ["node", "src/dispatch.ts"]
