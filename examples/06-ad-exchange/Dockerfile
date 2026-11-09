# Build context is the REPO ROOT (see docker-compose.yml) because the example depends on the unpublished
# @caffeinejs/* workspace packages, which must be built from source. The *.gen.mod.ts files are committed, so the
# Bun-only CLI never runs here.
FROM node:26-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2

WORKDIR /app

COPY . .
RUN npm ci

# The workspace packages the example imports. Their dist/ is excluded by the root .dockerignore.
RUN npm run build

WORKDIR /app/examples/06-ad-exchange

EXPOSE 9500

# tsx is exec'd directly rather than through `npm start`: npm does not reliably forward SIGTERM to its child, and the
# graceful shutdown hangs off that signal.
CMD ["/app/node_modules/.bin/tsx", "src/main.ts"]
