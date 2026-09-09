# Usurp — one image, three jobs: the web service, the migrate job, and the
# enroll operator tool (see `docker-compose.yml`). All three need the real
# workspace, which is why the web build is not `output: "standalone"`.

# ── build ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Manifests first, so `npm ci` is cached until a dependency actually changes.
# Every workspace package.json is required for npm to resolve the workspaces.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/readers/package.json ./packages/readers/
COPY packages/scoring/package.json ./packages/scoring/
COPY packages/db/package.json ./packages/db/
COPY packages/cli/package.json ./packages/cli/
COPY apps/web/package.json ./apps/web/

# `--omit=optional` skips @napi-rs/keyring. It is the CLI's keychain backend,
# has no musl prebuild, and nothing in this image runs the CLI — the container
# path for a device key is USURP_DEVICE_KEY, not a keychain.
RUN npm ci --omit=optional

COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts

# Project references build protocol -> readers -> db -> cli in order.
RUN npx tsc -b

# Next needs the workspace dists to already exist; `tsc -b` above provides them.
RUN --mount=type=cache,target=/root/.cache/next-swc npm -w @usurp/web run build

# ── runner ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    NEXT_TELEMETRY_DISABLED=1

# `dumb-init` reaps zombies and forwards signals, so `docker compose stop`
# actually stops Next rather than waiting out the timeout.
RUN apk add --no-cache dumb-init

COPY package.json package-lock.json ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/readers/package.json ./packages/readers/
COPY packages/scoring/package.json ./packages/scoring/
COPY packages/db/package.json ./packages/db/
COPY packages/cli/package.json ./packages/cli/
COPY apps/web/package.json ./apps/web/

RUN npm ci --omit=dev --omit=optional && npm cache clean --force

# Compiled output only — no TypeScript sources in the runtime image.
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/readers/dist ./packages/readers/dist
COPY --from=build /app/packages/scoring/dist ./packages/scoring/dist
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/cli/dist ./packages/cli/dist

# SQL migrations are data, not build output, and the migrate job reads them
# from the package root at runtime.
COPY --from=build /app/packages/db/drizzle ./packages/db/drizzle

COPY --from=build /app/apps/web/.next ./apps/web/.next
COPY --from=build /app/apps/web/next.config.ts ./apps/web/
COPY --from=build /app/scripts ./scripts

# `node` (uid 1000) ships with the base image. Running as root would also make
# the writable Next cache root-owned on a bind mount.
RUN chown -R node:node /app
USER node

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "-w", "@usurp/web", "run", "start"]
