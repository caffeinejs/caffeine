# The devtools UI, built from source. The context is the REPO ROOT, because the UI runs on the @caffeinejs/*
# workspace packages, which are not published:
#
#   docker build -f devtools-ui/Dockerfile -t caffeinejs/devtools-ui .
#
# Dockerfile.dockerignore, next to this file, keeps the context to those packages.

# Only the workspace manifests and the lockfile, so the install below is reused until a dependency changes rather
# than until any source does.
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS manifests
WORKDIR /src
COPY . .
RUN mkdir /manifests \
  && find . -name package.json -o -name package-lock.json | tar -cf - -T - | tar -xf - -C /manifests

# The output is JavaScript alone, so the build runs on the builder's platform even for an image of another.
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /src
COPY --from=manifests /manifests ./
RUN --mount=type=cache,target=/root/.npm \
  npm ci --ignore-scripts --no-audit --no-fund --workspace=@caffeinejs/devtools-ui --include-workspace-root
COPY . .
RUN npx tsc --build devtools-ui/tsconfig.build.json

# The production dependencies alone, then each linked workspace package as it would be published: what its `files`
# lists, plus the dependencies it nests.
RUN --mount=type=cache,target=/root/.npm \
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace=@caffeinejs/devtools-ui
RUN mkdir /app \
  && cp -a node_modules package.json /app/ \
  && node -e ' \
    const { cpSync, existsSync, readdirSync, readFileSync, realpathSync } = require("node:fs"); \
    const { join, relative } = require("node:path"); \
    for (const name of readdirSync("node_modules/@caffeinejs")) { \
      const dir = relative(".", realpathSync(join("node_modules/@caffeinejs", name))); \
      const { files } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); \
      for (const file of [...files, "node_modules"]) { \
        if (existsSync(join(dir, file))) cpSync(join(dir, file), join("/app", dir, file), { recursive: true, verbatimSymlinks: true }); \
      } \
    }'

# What only a compiler, an editor or a reader of the sources wants. The UI's own source maps stay, for
# NODE_OPTIONS=--enable-source-maps.
RUN find /app -type f \( -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.d.mts' -o -name '*.d.cts' \
    -o -name '*.tsbuildinfo' \) -delete \
  && find /app/node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name example \
    -o -name examples -o -name benchmark -o -name benchmarks -o -name .github \) -prune -exec rm -rf {} + \
  && find /app/node_modules -type f \( -name '*.map' -o -name '*.md' -o -name '*.markdown' \) -delete

# No shell, no package manager, and a non-root user (65532) by default.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:cb606325b7ec4af55462cb0b424a53b452a5b4a894ffe841fcf1048d216fb9f8

LABEL org.opencontainers.image.title="caffeinejs-devtools-ui" \
  org.opencontainers.image.description="A web UI for the CaffeineJS devtools endpoints" \
  org.opencontainers.image.source="https://github.com/caffeinejs/caffeine" \
  org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY --from=build /app ./

# Every setting is a CAFFEINE_DEVTOOLS_ variable (devtools-ui/README.md). The UI listens on every interface here,
# since the published port is how it is reached; it reads the devtools on 127.0.0.1:9090 unless
# CAFFEINE_DEVTOOLS_TARGET__URL names another address, which inside a container it almost always must.
ENV NODE_ENV=production \
  CAFFEINE_DEVTOOLS_SERVER__HOST=0.0.0.0 \
  CAFFEINE_DEVTOOLS_SERVER__PORT=9091

EXPOSE 9091
USER nonroot

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --start-interval=2s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch(`http://127.0.0.1:${process.env.CAFFEINE_DEVTOOLS_SERVER__PORT}/livez`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Node runs as PID 1 and handles SIGTERM itself: the application closes its server and exits.
CMD ["devtools-ui/dist/main.js"]
