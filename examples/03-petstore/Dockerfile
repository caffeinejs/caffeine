# Build context is the REPO ROOT (see docker-compose.yml) because the example depends on the
# unpublished @caffeinejs/* workspace packages, which must be built from source.
FROM node:22-bookworm-slim AS base

# openssl + ca-certificates are required by Prisma's query engine on Debian slim.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install and build the whole monorepo (di, std, http, cli, ...).
COPY . .
RUN npm ci
RUN npm run build

# The caffeine CLI's `generate` command is Bun-only — it uses Bun.Glob, Bun.file and Bun.write, and its published
# bin is a `bun build --compile` native binary that the root `tsc --build` never produces. So codegen runs in a Bun
# stage and only its one output file crosses back; Bun stays out of the runtime image.
#
# The whole /app is carried over rather than re-copied from context because caffeine.config.ts imports
# '@caffeinejs/cli', which resolves through the workspace symlinks that `npm ci` created above.
FROM oven/bun:1 AS codegen
WORKDIR /app
COPY --from=base /app /app
WORKDIR /app/examples/03-petstore
RUN bun /app/cli/dist/bin.js generate

FROM base AS runtime

# Only the generated DI registration file crosses the stage boundary.
COPY --from=codegen /app/examples/03-petstore/src/__caffeine__.gen.ts ./examples/03-petstore/src/__caffeine__.gen.ts

# Prisma's client generator is plain Node, so it stays here.
WORKDIR /app/examples/03-petstore
RUN npx prisma generate

EXPOSE 3000
CMD ["sh", "./docker-entrypoint.sh"]
