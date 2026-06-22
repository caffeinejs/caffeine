# 02 — Fastify Functions

TypeScript DI with a function style: services are plain classes registered via `di.bind()`, routes are functions registered as bindings. No class-level decorators on services.

Demonstrates a minimal Cats CRUD API.

## What it shows

- `di.bind(key).toClass(Class, [deps])` and `.toFunction(fn, [deps])` — functional registration
- Fastify plugin pattern with a shared `Container` passed through plugin options
- Request handling without controller classes

## Tech stack

- Node.js + TypeScript
- [Fastify](https://fastify.dev)
- `@caffeine-projects/dicaf`

## Run

```sh
# Start infrastructure
docker compose up -d

npm run start -w @caffeine-projects/example-fastify-functions
```
