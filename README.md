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
  <img src="https://img.shields.io/badge/status-work%20in%20progress-F2A93B" alt="Status: work in progress">
</p>

## About

CaffeineJS is a TypeScript framework for building server-side applications. It is a monorepo of focused `@caffeinejs/*` packages — an IoC container, HTTP, configuration, messaging, caching, resilience, and more — so an application depends on the pieces it uses and nothing else.

It is built on standard ECMAScript decorators, with no `experimentalDecorators`, `emitDecoratorMetadata` or `reflect-metadata` anywhere, and it carries types end to end: the configuration schema, the route handler and the HTTP client all check against the same definitions.

## Status

CaffeineJS is a work in progress and not ready for production. Its packages, APIs and documentation still change
often, and some features are incomplete.

Until 1.0.0, every release is a preview, `0.0.1-rc.N`, and any of them may break an application: each release's notes
on [GitHub Releases](https://github.com/caffeinejs/caffeine/releases) list its breaking changes first.

[Versioning](docs/versioning.md) explains why, and which Node.js versions are supported. To report a vulnerability,
see the [security policy](SECURITY.md).

## Overview

A taste of a Caffeine HTTP application. Routes are written as decorated controllers, with their dependencies
injected by the container:

```ts
import { $t } from '@caffeinejs/application/schema'
import { Injectable } from '@caffeinejs/di'
import { $p, Args, Controller, Get, Post, Schema, Status } from '@caffeinejs/http'

@Injectable()
class Greeter {
  greet(name: string) {
    return `Hello, ${name}`
  }
}

@Controller('/greetings', [Greeter])
class GreetingsController {
  constructor(private readonly greeter: Greeter) {}

  @Get('/:name')
  @Args([$p.param('name')])
  greet(name: string) {
    return { message: this.greeter.greet(name) }
  }

  @Post('/')
  @Status(201)
  @Schema({ body: $t.Object({ name: $t.String({ minLength: 1 }) }) })
  @Args([$p.body()])
  create(body: { name: string }) {
    return { message: this.greeter.greet(body.name) }
  }
}
```

Or as a router, which injects its dependencies into the handler and whose schema types the request: `ctx.req.body()`
below is `{ item: string; quantity: number }`.

```ts
import { $t } from '@caffeinejs/application/schema'
import { Injectable } from '@caffeinejs/di'
import { createWebApplication, newRouter } from '@caffeinejs/http/fastify'

@Injectable()
class Orders {
  place(item: string, quantity: number) {
    return { id: crypto.randomUUID(), item, quantity }
  }
}

const orders = newRouter('/orders')
  .inject({ orders: Orders })
  .post('/')
  .schema({ body: $t.Object({ item: $t.String(), quantity: $t.Integer({ minimum: 1 }) }) })
  .handler((ctx, { orders }) => {
    const { item, quantity } = ctx.req.body()
    
    return ctx.status(201).body(orders.place(item, quantity))
  })

const app = createWebApplication().mount(orders)
await app.run({ port: 3000 })
```

## License

This project is [MIT](LICENSE) licensed.
