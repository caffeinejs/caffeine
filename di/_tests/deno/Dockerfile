# Consume the library as a real Deno (npm-compat) user would.
# Requires dist/ in the build context: CI downloads the ci job artifact; local runs need npm run build first.
FROM denoland/deno:2.8.1@sha256:ddaad47cbbbbd856d73bd0d50074a0e308c51671d83442eebb15f1039dd4a822
WORKDIR /app
RUN mkdir -p vendor
COPY package.json vendor/
COPY _tests/deno/deno.json _tests/deno/package.json _tests/deno/compat_test.ts _tests/deno/scan_test.ts ./
RUN deno install
COPY scan vendor/scan
COPY dist vendor/dist
COPY _tests/deno/_testdata ./_testdata
# --no-check: this is a runtime compatibility smoke test. Type-checking the
# shipped .d.ts pulls in npm:@types/node, which is irrelevant to runtime behavior.
CMD ["deno", "test", "-A", "--no-check", "--ignore=./vendor"]
