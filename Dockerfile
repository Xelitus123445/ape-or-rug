# One container for the playtest build: the Node server plays the rooms and
# serves the built web app and the room socket on $PORT. Node runs the
# TypeScript sources directly, so only the web app needs a build step.
# Rooms live in memory: run exactly one replica.

FROM node:26-slim AS build
WORKDIR /app
RUN npm install -g pnpm@12.18.0
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/game/package.json packages/game/
COPY packages/sim/package.json packages/sim/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:26-slim
WORKDIR /app
RUN npm install -g pnpm@12.18.0
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/game/package.json packages/game/
COPY packages/sim/package.json packages/sim/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# Production dependencies of the server and the workspace packages it uses, nothing else.
RUN pnpm install --prod --frozen-lockfile --filter "@ape/server..." && npm uninstall -g pnpm
COPY packages/engine/src packages/engine/src
COPY packages/game/src packages/game/src
COPY apps/server/src apps/server/src
COPY --from=build /app/apps/web/dist apps/web/dist

# Events go to /data: mount a volume there so they survive a redeploy.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 EVENTS_FILE=/data/events.jsonl
EXPOSE 8080
CMD ["node", "apps/server/src/main.ts"]
