FROM node:24-bookworm-slim AS build
ARG BUILD_COMMIT=unknown
WORKDIR /opt/command
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm run typecheck:libs \
 && pnpm --filter @workspace/api-server run test \
 && pnpm --filter @workspace/api-server run build \
 && PORT=8080 BASE_PATH=/ pnpm --filter @workspace/zioncore-command run build \
 && pnpm --filter @workspace/api-server deploy --legacy --prod /opt/command/runtime

FROM node:24-bookworm-slim AS runtime
ARG BUILD_COMMIT=unknown
WORKDIR /opt/command
ENV NODE_ENV=production PORT=8080 COMMAND_WEB_DIR=/opt/command/web
LABEL org.opencontainers.image.revision=$BUILD_COMMIT
COPY --from=build /opt/command/runtime/node_modules ./node_modules
COPY --from=build /opt/command/artifacts/api-server/dist ./dist
COPY --from=build /opt/command/artifacts/zioncore-command/dist/public ./web
COPY --from=build /opt/command/zioncore-release.json ./zioncore-release.json
USER node
EXPOSE 8080
CMD ["node","dist/index.mjs"]
