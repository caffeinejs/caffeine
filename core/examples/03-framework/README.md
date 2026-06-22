# 03 — Framework

Build a minimal MVC routing framework on top of DiCaf. Custom decorators (`@Controller`, `@Get`, `@Post`, `@Param`, `@Query`, `@Body`) attach metadata to bindings; the bootstrap code reads those tags and registers Fastify routes automatically.

## What it shows

- `binding.tags` — attaching arbitrary metadata to DI bindings
- `di.getBindingsByLabel(symbol)` — discovering bindings by label at runtime
- Building a thin framework layer (controller routing) on top of DiCaf
- `@Injectable`, `@Lifecycle`, `@Named` decorators

## Tech stack

- Node.js + TypeScript
- [Fastify](https://fastify.dev)
- `@caffeine-projects/dicaf`

## Run

```sh
npm run start -w @caffeine-projects/example-framework
```
