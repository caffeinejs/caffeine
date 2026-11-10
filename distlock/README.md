# @caffeinejs/distlock

Distributed locks for CaffeineJS applications. The backends are their own imports:
`@caffeinejs/distlock/backend/memory` for a single process and `@caffeinejs/distlock/backend/redis` for several.
OpenTelemetry instruments are under `@caffeinejs/distlock/observability/otel`.

```sh
npm install -E @caffeinejs/distlock
```

Install every `@caffeinejs/*` package at the same exact version: [Versioning](https://github.com/caffeinejs/caffeine/blob/main/docs/versioning.md).

## License

[MIT](LICENSE)
