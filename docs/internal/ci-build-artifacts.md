# CI build artifacts and package-specific setup

Contributor notes that are too rare for every agent turn. Root [`CONVENTIONS.md`](../../CONVENTIONS.md) links here.

## CI build outputs

`.github/workflows/ci.yml` has one `build` job producing `dist/` for each package, then a separate `test` job that only receives the dists explicitly listed — it does not rebuild. Whenever a **new workspace package** is added that has its own `dist/` (declares `"types": "dist/..."` or `"exports"` pointing into `dist/`) **and** is imported by another package's tests (i.e. it has an entry in the root `vitest.config.ts` `test.projects` list, directly or via a dependent project), add its dist path to **both**:

1. The `for d in ...` list in the `Verify Build Outputs` step
2. The `path:` list in the `Upload Build Artifacts` step

Missing either one does not fail the `build` job — it only surfaces later as a `vite:import-analysis` "Failed to resolve entry for package" error in the `test` job, since that package's dist never reached the test runner. A package with no cross-package test consumers (e.g. `scan`, only used by `di/examples/*`) does not need this.

## Petstore codegen

Keep package-specific setup out of the root scripts. The petstore example has two generated, untracked artifacts its specs import — the Prisma client and `src/**/*.gen.mod.ts` (`caffeine generate`). Rather than chaining codegen into the root `test`/`test:typecheck` (which would fire for every unrelated package), the petstore regenerates them in its **own vitest `globalSetup`** ([examples/03-petstore/vitest.globalsetup.ts](../../examples/03-petstore/vitest.globalsetup.ts) → `npm run generate`) when `src/root.gen.mod.ts` or `node_modules/.prisma/client` is missing. A fresh CI checkout has neither, so generate still runs once per job; local loops after the first generate skip it. Force with `npm run generate -w @caffeinejs/example-petstore`. Its CI build job also generates them (via `npm run build --workspaces`) before the root type-check.

## CLI binary

`@caffeinejs/cli` ships a bun-compiled binary at `cli/dist/caffeine`. Package `build` is `tsc` only — same as every other workspace. Root `npm run build` (`tsc`) does not produce the binary either. Run `npm run build:cli` (or `make build:cli`) after clone/clean so `node_modules/.bin/caffeine` exists before any example `caffeine generate`. That script runs `compile` (`bun build --compile`) then relinks the bin.

`build:examples` compiles the binary only when `cli/dist/caffeine` is missing. `make check` rebuilds it when it is missing or older than CLI sources. CI calls `build:cli` once explicitly; `npm run build --workspaces` does not bun-compile.

## CodeQL

`.github/workflows/codeql.yml` runs GitHub CodeQL on push and pull request to `main` (skipping docs-only changes) and on a weekly schedule. Language is `javascript-typescript` with `build-mode: none`. It is a separate workflow from CI; it does not consume or produce `dist/` artifacts. Do not also enable GitHub's UI default CodeQL setup — that would duplicate this scan.

## License allowlist and dependency review

`.github/workflows/license-check.yml` runs on pull requests and on pushes to `main` / `[0-9]+.x`. On PRs it also runs GitHub Dependency Review (`fail-on-severity: high`). The license job runs `npm run license:check`, which walks production dependency trees of first-party workspace packages (examples, benchmarks, scaffold templates, and `di/_tests/deno` are excluded) and fails if any third-party SPDX license is outside the allowlist in `tools/check-licenses.mjs`.

## Coverage

The `test` job in `.github/workflows/ci.yml` runs `npm run test:coverage` only on Linux + Node 24. That job posts a per-package line-coverage table to the GitHub Actions summary (`tools/coverage-summary.mjs`) and uploads `coverage/lcov.info` to Codecov via OIDC (`codecov/codecov-action`, `use_oidc: true`). The same job uploads `coverage/junit.xml` as Test Analytics (`report_type: test_results`). Coverage and test-result uploads use `if: ${{ !cancelled() }}` so a failing suite still reports. Other matrix cells run `npm test` without instrumentation.

`examples/` is excluded from coverage (`vitest` `coverage.exclude`, `codecov.yml` `ignore`, and the summary script). Example projects may still run as tests.

[`codecov.yml`](../../codecov.yml) sets project and patch status to informational. Do not add Codecov as a required GitHub check. There is no coverage threshold.
