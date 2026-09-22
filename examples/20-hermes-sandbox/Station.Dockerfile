FROM docker:27.5.1-cli AS docker-cli
FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@10.28.2
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm --filter station-daemon... --filter station-dashboard... install --frozen-lockfile
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter station-daemon... --filter station-dashboard... run build
COPY examples/20-hermes-sandbox ./examples/20-hermes-sandbox

FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS controller
RUN apt-get update && apt-get install -y --no-install-recommends util-linux ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/examples/20-hermes-sandbox ./examples/20-hermes-sandbox
ENV STATION_DATA_DIR=/data NODE_ENV=production
CMD ["flock", "--nonblock", "/data/controller.lock", "node", "examples/20-hermes-sandbox/container-entry.mjs"]

FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS dashboard
WORKDIR /app
COPY --from=build /app/packages/station-dashboard/.next/standalone ./packages/station-dashboard/.next/standalone
COPY --from=build /app/packages/station-dashboard/bin ./packages/station-dashboard/bin
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
USER node
CMD ["node", "packages/station-dashboard/bin/station-dashboard.mjs"]
