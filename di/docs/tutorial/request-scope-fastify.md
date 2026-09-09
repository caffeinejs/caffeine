---
sidebar_label: Request Scope with Fastify
---

# Tutorial: Request scope with Fastify

This tutorial shows how to wire CaffeineIoC's request scope into a Fastify application.
By the end you will have a container that creates a fresh `RequestContext` per HTTP
request and makes it available to any service that needs it.

**Prerequisites:** Node.js ≥ 20, TypeScript 5+, a Fastify project.

---

## 1. Install

```sh
npm install @caffeinejs/di fastify
```

---

## 2. TypeScript config

CaffeineIoC uses TC39 stage 3 decorators — no `reflect-metadata` needed.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "experimentalDecorators": false,
    "strict": true
  }
}
```

---

## 3. Create a request-scoped service

`Scopes.REQUEST` tells CaffeineIoC to create a new instance for each request and discard it
when the request ends.

```ts
// src/request.context.ts
import { Injectable, Lifetime, PostConstruct } from '@caffeinejs/di/decorators'
import { Scopes } from '@caffeinejs/di'

@Injectable()
@Lifetime(Scopes.REQUEST)
export class RequestContext {
  readonly correlationId = crypto.randomUUID()

  @PostConstruct()
  onCreated(): void {
    console.log(`[${this.correlationId}] request started`)
  }
}
```

---

## 4. Wire the container into Fastify

The `onRequest` hook calls `requestScopeManager.run()`. Everything inside that
callback runs within a single request's async context — CaffeineIoC uses it to isolate
request-scoped instances between concurrent requests.

The scope ends when the callback settles, and `done()` returns as soon as Fastify
reaches its first `await` — long before the response is sent. So the callback returns
a promise that stays pending until the raw response closes, which is the one signal
that fires for a response that finished, one that errored, and a connection the client
dropped. Resolve it any earlier and a handler that streams, or a body still being
piped, outlives the scope it depends on.

```ts
// src/app.ts
import fastify from 'fastify'
import type { Container } from '@caffeinejs/di'

export async function buildServer(container: Container) {
  const server = fastify({ logger: true })

  server
    .addHook('onRequest', (_req, reply, done) => {
      void container.requestScopeManager.run(
        () =>
          new Promise<void>(resolve => {
            reply.raw.once('close', () => resolve())
            done()
          }),
      )
    })
    .addHook('onClose', async () => {
      await container.dispose()
    })

  return server
}
```

`onClose` disposes the container when Fastify shuts down, running any `onDestroy`
hooks on singleton services.

---

## 5. Inject `RequestContext` into a singleton

Singleton services cannot directly receive a request-scoped dependency — their
instance is created once, before any request arrives. Use `provide()` to get a
`Provider<T>` instead: a thin wrapper that resolves the current request's instance
on each call.

```ts
// src/cats.service.ts
import { provide, type Provider } from '@caffeinejs/di'
import { Injectable } from '@caffeinejs/di/decorators'
import { RequestContext } from './request.context.js'

@Injectable([provide(RequestContext)])
export class CatsService {
  constructor(private readonly ctx: Provider<RequestContext>) {}

  findAll(): string[] {
    console.log(`[${this.ctx.get().correlationId}] findAll`)
    return ['Whiskers', 'Shadow']
  }
}
```

`this.ctx.get()` is called at request time, not at construction time, so it always
returns the instance that belongs to the current request.

---

## 6. Register routes and start

```ts
// src/index.ts
import { CaffeineIoC } from '@caffeinejs/di'
import { buildServer } from './app.js'
import { CatsService } from './cats.service.js'

const container = new CaffeineIoC()
await container.init()

const server = await buildServer(container)

server.get('/cats', async () => {
  return container.get(CatsService).findAll()
})

await server.listen({ port: 3000, host: '0.0.0.0' })
```

---

## How it works

```
HTTP request arrives
  │
  ├─ onRequest hook → requestScopeManager.run()
  │     Creates an isolated async context for this request
  │
  ├─ route handler runs
  │     container.get(CatsService)          → singleton (reused)
  │     CatsService.ctx.get()               → RequestContext for this request
  │
  └─ raw response closes
        Request scope is discarded — RequestContext is garbage collected
```

Each concurrent request gets its own `RequestContext`. They never share state.

---

## What's next

- Add more request-scoped services the same way — annotate with `@Lifetime(Scopes.REQUEST)` and inject via `provide()`.
- Use `scan()` to auto-import decorated files instead of listing them manually. See the [Scanning Files guide](../guides/scanning-files.md).
- See the [Mixing Scopes guide](../guides/mixing-scopes.md) for the full explanation of why `provide()` is required.
- A complete working example with PostgreSQL, Redis, and health checks is available in the [`core/examples/04-fastify-cats-complete`](https://github.com/caffeinejs/di/tree/main/core/examples/04-fastify-cats-complete) directory.
