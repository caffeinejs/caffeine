<p align="center">
  <img src="docs/assets/logo.svg" alt="" width="128" height="128">
</p>

<h1 align="center">CaffeineJS</h1>

<p align="center">
  Modular, batteries-included TypeScript framework for server-side applications.<br>
  Built on standard ECMAScript decorators.<br>
  End-to-end type safety.
</p>

<p align="center">
  <a href="https://github.com/caffeinejs/caffeine/actions/workflows/ci.yml"><img src="https://github.com/caffeinejs/caffeine/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://codecov.io/gh/caffeinejs/caffeine"><img src="https://codecov.io/gh/caffeinejs/caffeine/graph/badge.svg?token=CH1MHCDV1J" alt="codecov"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/caffeinejs/caffeine"><img src="https://api.scorecard.dev/projects/github.com/caffeinejs/caffeine/badge" alt="OpenSSF Scorecard"></a>
  <a href="https://sonarcloud.io/summary/new_code?id=caffeinejs_caffeine"><img src="https://sonarcloud.io/api/project_badges/measure?project=caffeinejs_caffeine&amp;metric=alert_status" alt="Quality gate status"></a>
  <img src="https://img.shields.io/badge/status-release%20candidate-F2A93B" alt="Status: release candidate">
</p>

## About

CaffeineJS is a TypeScript framework for building server-side applications. It is a monorepo of focused `@caffeinejs/*` packages — an IoC container, HTTP, configuration, messaging, caching, resilience, and more — so an application depends on the pieces it uses and nothing else.

It is built on standard ECMAScript decorators, with no `experimentalDecorators`, `emitDecoratorMetadata` or `reflect-metadata` anywhere, and it carries types end to end: the configuration schema, the route handler and the HTTP client all check against the same definitions.

## Status

CaffeineJS is released as release candidates, `0.0.1-rc.N`, until 1.0.0. Any of them may break an application: each
release's notes on [GitHub Releases](https://github.com/caffeinejs/caffeine/releases) list its breaking changes first.

## Install

Every `@caffeinejs/*` package is released at the same version. Install the ones an application uses at one exact
version:

```sh
npm install -E @caffeinejs/http @caffeinejs/application @caffeinejs/di
```

[Versioning](docs/versioning.md) explains why, and which Node.js versions are supported. To report a vulnerability,
see the [security policy](SECURITY.md).

## License

This project is [MIT](LICENSE) licensed.
