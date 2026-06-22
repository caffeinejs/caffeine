# 05 — Fastify Cats (Complete)

A full production-like API that demonstrates advanced DiCaf features: async initialization, refresh scope, request scope, lazy providers, and runtime config reloading from Google Cloud Storage.

## What it shows

- `@Async()` — async factory beans resolved at `init()` time
- `@Refresh()` + `RefreshScope` — re-resolve a binding without restarting the process
- `provide(Token)` → `Provider<T>` — late / repeated resolution of a binding inside a singleton
- `@Scope(RequestScope)` — per-request instances tied to a request context
- `@Lazy()` — defer instantiation until first use
- `@Configuration` + `@Provides` — multi-binding configuration classes
- `@PreDestroy()` — cleanup hooks on container shutdown
- Worker threads polling GCS metadata; `generation` change triggers `refresher.refresh()`
- `@caffeine-projects/dicaf/scan` — auto-scan directory and register decorated classes

## Tech stack

- Node.js + TypeScript
- [Fastify](https://fastify.dev)
- PostgreSQL (via `pg`)
- Redis (via `ioredis`)
- Google Cloud Storage (via `@google-cloud/storage`, emulated by `fsouza/fake-gcs-server`)
- `@caffeine-projects/dicaf`

## Run

```sh
# Start all infrastructure (PostgreSQL, Redis, fake GCS)
make example-cats-complete

# Stop everything
make example-cats-complete-stop
```

## Live config reload

Edit `_tests/_testdata/gcs/data/cats/data.config.json`, then push it to the running fake GCS server:

```sh
make example-cats-push-config
```

The watcher detects the new object generation within 5 seconds and triggers a refresh — no restart needed.
