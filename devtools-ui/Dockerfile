# Build from the repo root: docker build -f devtools-ui/Dockerfile .

# Manifests alone, so the install layer is cached until a dependency changes.
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS manifests
WORKDIR /src
COPY . .
RUN mkdir /manifests \
  && find . -name package.json -o -name package-lock.json | tar -cf - -T - | tar -xf - -C /manifests

FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /src
COPY --from=manifests /manifests ./
RUN --mount=type=cache,target=/root/.npm \
  npm ci --ignore-scripts --no-audit --no-fund --workspace=@caffeinejs/devtools-ui --include-workspace-root
COPY . .
RUN node_modules/.bin/tsc --build devtools-ui/tsconfig.build.json

# Copies each linked workspace package as published: its `files` plus any nested node_modules.
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
        if (existsSync(join(dir, file))) { \
          cpSync(join(dir, file), join("/app", dir, file), { recursive: true, verbatimSymlinks: true }); \
        } \
      } \
    }'

RUN find /app -type f \( -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.d.mts' -o -name '*.d.cts' \
    -o -name '*.tsbuildinfo' \) -delete \
  && find /app/node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name example \
    -o -name examples -o -name benchmark -o -name benchmarks -o -name .github \) -prune -exec rm -rf {} + \
  && find /app/node_modules -type f \( -name '*.map' -o -name '*.md' -o -name '*.markdown' \) -delete

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:cb606325b7ec4af55462cb0b424a53b452a5b4a894ffe841fcf1048d216fb9f8

LABEL org.opencontainers.image.title="caffeinejs-devtools-ui" \
  org.opencontainers.image.description="A web UI for the CaffeineJS devtools endpoints" \
  org.opencontainers.image.source="https://github.com/caffeinejs/caffeine" \
  org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY --from=build /app ./

ENV NODE_ENV=production \
  CAFFEINE_DEVTOOLS_SERVER__HOST=0.0.0.0 \
  CAFFEINE_DEVTOOLS_SERVER__PORT=9091

EXPOSE 9091
USER nonroot

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --start-interval=2s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch(`http://127.0.0.1:${process.env.CAFFEINE_DEVTOOLS_SERVER__PORT}/livez`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["devtools-ui/dist/main.js"]
