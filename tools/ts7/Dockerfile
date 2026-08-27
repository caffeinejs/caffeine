# Isolated TypeScript 7 compiler for `make ts7`. Host `tsc` stays 6.x.
# The image must not inherit the repo `.npmrc` (`ignore-scripts=true`).
FROM node:24-bookworm-slim

ARG TS_VERSION=7.0.2
RUN npm install -g "typescript@${TS_VERSION}"

WORKDIR /work
ENTRYPOINT ["tsc"]
