# Versioning

How CaffeineJS packages are versioned, which versions to install together, and what a release may change.

## One version for every package

Every `@caffeinejs/*` package is released together, at the same version, whether it changed or not. A package names
the other `@caffeinejs/*` packages it needs as peer dependencies pinned to that exact version: `@caffeinejs/http` at
`0.0.1-rc.2` needs `@caffeinejs/di` at `0.0.1-rc.2`, not `0.0.1-rc.1`.

So an application installs every `@caffeinejs/*` package at one version, and pins it:

```sh
npm install -E @caffeinejs/http @caffeinejs/application @caffeinejs/di
```

With two versions in one application, npm refuses the install with a peer dependency conflict, and other package
managers warn: the application would load two copies of the container. Upgrade them together, naming the version:

```sh
npm install -E @caffeinejs/http@0.0.1-rc.3 @caffeinejs/application@0.0.1-rc.3 @caffeinejs/di@0.0.1-rc.3
```

## Before 1.0.0

Releases before 1.0.0 are release candidates: `0.0.1-rc.1`, `0.0.1-rc.2`, and so on. Any of them may break an
application: a rename, a removed option, a changed default. Each release's notes list its breaking changes first.

## From 1.0.0

Versions follow [Semantic Versioning](https://semver.org/): a breaking change comes only in a new major version.

## Dist-tags

| Dist-tag | Before 1.0.0                       | From 1.0.0                |
| -------- | ---------------------------------- | ------------------------- |
| `latest` | The newest release, candidates too | The newest stable release |
| `next`   | Not used                           | The newest prerelease     |

`npm install @caffeinejs/http` without a version installs `latest`.

## Release notes

Every release has its notes on [GitHub Releases](https://github.com/caffeinejs/caffeine/releases), built from the
titles of the pull requests it holds: breaking changes, then features, fixes, performance and documentation.

## Runtime

| Requirement | Supported                                                                                |
| ----------- | ---------------------------------------------------------------------------------------- |
| Node.js     | 24 and 26, the versions CI tests. Every package declares `"engines": { "node": ">=24" }` |
| Modules     | ES modules only                                                                          |
| Decorators  | Standard ECMAScript decorators. No `experimentalDecorators` or `emitDecoratorMetadata`   |

The `caffeine` command of `@caffeinejs/cli` is a native binary, built for Linux (x64 and arm64, glibc and musl), macOS
(x64 and arm64) and Windows (x64).
