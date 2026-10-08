# Consume the library as a real Deno (npm-compat) user would.
# Requires dist/ in the build context: CI downloads the ci job artifact; local runs need npm run build first.
FROM denoland/deno:2.9.7@sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432
WORKDIR /app
RUN mkdir -p vendor
COPY package.json vendor/
COPY _tests/deno/deno.json _tests/deno/package.json _tests/deno/compat_test.ts ./
RUN deno install
COPY dist vendor/dist
# --no-check: this is a runtime compatibility smoke test. Type-checking the
# shipped .d.ts pulls in npm:@types/node, which is irrelevant to runtime behavior.
CMD ["deno", "test", "-A", "--no-check", "--ignore=./vendor"]
