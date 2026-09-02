# CI build artifacts and package-specific setup

Contributor notes that are too rare for every agent turn. Root [`CONVENTIONS.md`](../../CONVENTIONS.md) links here.

## CI build outputs

`.github/workflows/ci.yml` has one `build` job producing `dist/` for each package, then a separate `test` job that only receives the dists explicitly listed — it does not rebuild. Whenever a **new workspace package** is added that has its own `dist/` (declares `"types": "dist/..."` or `"exports"` pointing into `dist/`) **and** is imported by another package's tests (i.e. it has an entry in the root `vitest.config.ts` `test.projects` list, directly or via a dependent project), add its dist path to **both**:

1. The `for d in ...` list in the `Verify Build Outputs` step
2. The `path:` list in the `Upload Build Artifacts` step

Missing either one does not fail the `build` job — it only surfaces later as a `vite:import-analysis` "Failed to resolve entry for package" error in the `test` job, since that package's dist never reached the test runner. A package with no cross-package test consumers (e.g. `scan`, only used by `di/examples/*`) does not need this.

## Petstore codegen

Keep package-specific setup out of the root scripts. The petstore example has two generated, untracked artifacts its specs import — the Prisma client and `src/**/*.generated.mod.ts` (`caffeine generate`). Rather than chaining codegen into the root `test`/`test:typecheck` (which would fire for every unrelated package), the petstore regenerates them in its **own vitest `globalSetup`** ([examples/03-petstore/vitest.globalsetup.ts](../../examples/03-petstore/vitest.globalsetup.ts) → `npm run generate`), so codegen runs only when the petstore's own vitest project runs. Its CI build job also generates them (via `npm run build --workspaces`) before the root type-check.

## CLI binary

`@caffeinejs/cli` ships a bun-compiled binary at `cli/dist/caffeine`. Root `npm run build` (`tsc`) does not produce it — run `npm run build:cli` (or `make build:cli`) after clone/clean so `node_modules/.bin/caffeine` exists before any example `caffeine generate`. `build:examples` and CI already call `build:cli` first.
