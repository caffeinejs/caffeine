# Releasing

How a maintainer releases every `@caffeinejs/*` package. A `v*` tag starts
[`.github/workflows/release.yml`](.github/workflows/release.yml), which checks the tag, packs the packages once,
drafts the GitHub release, publishes to npm once a reviewer approves, pushes the devtools-ui image, and publishes the
GitHub release. What users get is in [`docs/versioning.md`](docs/versioning.md).

## One-time settings

On GitHub, in the repository settings:

- **Environments:** a `release` environment with you as a required reviewer. Without one, nothing stops a tag from
  publishing.
- **Rules:** a tag ruleset for `v*` that only maintainers may create, update or delete, and a branch ruleset for `main`
  and every `N.x` branch that requires pull requests and the PR title check. Do not require the CI checks: CI skips a
  change to Markdown or `docs/` alone, and a required check that never runs blocks the merge.
- **Releases:** immutable releases, so a published release's tag and files cannot change.
- **Security:** private vulnerability reporting, which [`SECURITY.md`](SECURITY.md) points reporters to.

On npm: the `caffeinejs` organization, with two-factor authentication required for every member.

## Cut a release

1. On a branch from `main`, set the version and check it:

   ```sh
   npm run release:version -- 0.0.1-rc.2
   make check
   ```

2. Open a pull request titled `chore(release): v0.0.1-rc.2` and merge it once CI passes.
3. Wait for CI on `main` to pass on the merge commit, merging nothing else until it does: a later merge cancels that
   run. Then tag that commit:

   ```sh
   git tag v0.0.1-rc.2 <commit>
   git push origin v0.0.1-rc.2
   ```

4. When the `Draft` job ends, read the draft on GitHub Releases. Edit its notes if needed: a run started again keeps
   them.
5. Approve the `Publish` job. The `Image` and `Finalize` jobs follow, and the release goes public.
6. Check what users get: `npm view @caffeinejs/http@0.0.1-rc.2`, the release page with its SBOMs, and the image, as
   [Verifying a release](SECURITY.md#verifying-a-release) shows.

To rehearse without a tag, run the Release workflow by hand on `main`: it runs every check, packs, writes the notes in
the run summary and runs `npm publish --dry-run`, and creates and publishes nothing.

## The first release

npm accepts a trusted publisher only for a package that exists, so `0.0.1-rc.1` is published from your machine:

1. Follow steps 1 and 2 of [Cut a release](#cut-a-release) with `0.0.1-rc.1`, and wait for CI on `main` to pass on
   the merge commit.
2. On the merge commit, with a clean working tree, pack and publish. npm asks for your second factor as it publishes;
   if it stops partway, run the publish again: it skips what npm has.

   ```sh
   npm ci
   npm run release:pack
   npm login
   node tools/publish.mjs artifacts
   ```

3. Make the release workflow the publisher of every package (npm 11.15.0 or later):

   ```sh
   for name in $(node -p "require('./artifacts/packages.json').map(({ name }) => name).join(' ')"); do
     npm trust github "$name" --file release.yml --repo caffeinejs/caffeine --env release --allow-publish --yes
   done
   ```

4. On npmjs.com, set each package's **Settings → Publishing access** to "Require two-factor authentication and
   disallow tokens". Trusted publishing keeps working.
5. Tag the merge commit `v0.0.1-rc.1` and push the tag, as in step 3 of [Cut a release](#cut-a-release). With no
   earlier tag, the draft's notes list every commit in the history: edit them down before you approve the `Publish`
   job, which finds every package on npm and skips it. The image is pushed and the GitHub release published.
6. After the image is pushed, make the `devtools-ui` package on GHCR public.

## A package released for the first time

A release that adds a package fails at its publish: the package has no trusted publisher yet. Publish that one from
your machine, then let the run finish:

1. Download the run's tarballs: `gh run download <run id> --name packages --dir artifacts`.
2. Publish the new package's tarball, under the dist-tag the release uses (`latest` before 1.0.0; from 1.0.0, `next`
   for a prerelease): `npm publish artifacts/<tarball> --access public --tag latest`.
3. Run `npm trust github` for it as in [The first release](#the-first-release), and set its publishing access.
4. Re-run the failed jobs. The publish skips every package npm has.

That first version has no provenance, and no earlier one for it to fall short of.

## When a run fails

- **`Verify` says CI has not passed.** A tag pushed before CI ended: wait for CI, then re-run all jobs. A commit that
  changed only Markdown or `docs/` starts no CI: while it is still the head of `main`, run the CI workflow by hand on
  `main`, then re-run all jobs. A run a later merge cancelled cannot be run again for that commit: delete the tag, and
  tag the newer commit once its CI passes. It holds the same version.
- **Before `Publish`, nothing is on npm.** Fix the cause, delete the tag and the draft release, and tag again.
- **`Publish` stops partway.** Re-run the failed jobs: the publish skips every package npm has. Right after a
  failure, npm may still report a version it just took as missing, and then refuse to publish over it: wait a few
  minutes and re-run.
- **`Image` fails.** Re-run the failed jobs. Until `Finalize` runs, the GitHub release stays a draft while npm has the
  packages.

Once any package of a version is on npm, the version is spent: fix forward with the next one.

## After changing `engines.bun`

Pin the new Bun runtimes, and commit `tools/bun-runtimes.json` with the change. Packing refuses runtimes that are not
pinned:

```sh
npm run release:pin-bun
```

## Never publish from your machine

After `0.0.1-rc.1`, only the release workflow publishes, apart from a new package's first version. Every version it
publishes carries provenance, and pnpm's `trustPolicy: no-downgrade` refuses a version with weaker provenance than
the ones before it, so a version published from a machine fails to install there.

## Withdraw a bad release

Deprecate the version of every package, and release the next one with the fix:

```sh
npm access list packages @caffeinejs --json \
  | node -e 'for (const name of Object.keys(JSON.parse(require("fs").readFileSync(0, "utf8")))) console.log(name)' \
  | while read -r name; do npm deprecate "$name@0.0.1-rc.2" "Broken: install 0.0.1-rc.3"; done
```

Do not unpublish. npm allows it only within 72 hours and only for a version nothing depends on, and the version
number stays spent.
