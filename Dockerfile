# OpenMuse MIT. Single API process owns embedded PGlite and its task worker.
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
COPY patches ./patches
COPY apps/mobile/package.json ./apps/mobile/package.json
COPY apps/worker/package.json ./apps/worker/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --filter openmuse
COPY apps/server ./apps/server
# Share the existing public-address validator and its error type with the HTTP reader.
COPY apps/worker/src/network.ts apps/worker/src/errors.ts ./apps/worker/src/
COPY packages ./packages
RUN pnpm build:server

FROM node:24.21.0-bookworm-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE ./
COPY docs/licenses ./docs/licenses
RUN mkdir -p /data/openmuse && chown node:node /data/openmuse
ENV NODE_ENV=production DATA_DIR=/data/openmuse HOST=0.0.0.0 PORT=8787
USER node
EXPOSE 8787
CMD ["node", "dist/apps/server/src/index.js"]
