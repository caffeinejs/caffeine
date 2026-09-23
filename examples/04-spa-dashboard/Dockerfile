# Build context is the REPO ROOT (see docker-compose.yml) because the example depends on the unpublished
# @caffeinejs/* workspace packages, which must be built from source.
#
# One stage, where the petstore needs three. The difference is codegen: that example's module graph is not
# committed and `caffeine generate modules` is Bun-only, so it pays for a Bun stage. This example's
# *.gen.mod.ts are committed, so the CLI never runs here and Bun never enters the picture.
FROM node:22-bookworm-slim

WORKDIR /app

COPY . .
RUN npm ci

# The workspace packages the example imports. Their dist/ is excluded by the root .dockerignore, which is what
# makes building them here mandatory rather than incidental.
RUN npm run build

# `build:web` rather than the example's own `build`, which would also run `caffeine generate modules` against a
# CLI binary that is not in the image. This is the esbuild step alone: hashed bundles under web/dist plus the
# .br and .gz siblings the static mount serves with `preCompressed`.
RUN npm run build:web -w @caffeinejs/example-spa-dashboard

WORKDIR /app/examples/04-spa-dashboard

EXPOSE 9010

# tsx is exec'd directly rather than through `npm start`: npm does not reliably forward SIGTERM to its child,
# and every graceful-shutdown behaviour this example demonstrates hangs off that signal.
CMD ["/app/node_modules/.bin/tsx", "api/main.ts"]
