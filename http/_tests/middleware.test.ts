import { CaffeineIoC, Scopes, token } from '@caffeinejs/di'
import fastify from 'fastify'
import { describe, it, expect } from 'vitest'

import {
  Catch,
  type Context,
  Controller,
  ErrPipelineSealed,
  Get,
  type Middleware,
  type Next,
  createWebApplication,
  fastifyAdapterFactory,
} from '../index.js'

// Controllers are registered globally at decoration time and a container snapshots them when it is
// constructed, so every controller in this file is declared up front rather than inside the test that uses
// it.

class ErrMiddlewareFailed extends Error {}

@Controller('/mw-catch')
class CatchingController {
  @Get('/')
  list() {
    return { ok: true }
  }

  @Catch(ErrMiddlewareFailed)
  async onFailure(ctx: Context, error: ErrMiddlewareFailed): Promise<void> {
    ctx.status(500).body({ by: 'controller', error: error.message })
  }
}
void [CatchingController]

@Controller('/mw')
class MiddlewareController {
  @Get('/echo')
  echo() {
    return { ok: true }
  }
}
void [MiddlewareController]

const kTagger = token<Tagger>(Symbol('tagger'))

class Tag {
  constructor(readonly value: string) {}
}

class Tagger implements Middleware {
  constructor(private readonly tag: Tag) {}

  handle(ctx: Context, next: Next): void {
    ctx.header('x-tag', this.tag.value)
    next()
  }
}

let counterInstances = 0

class Counter implements Middleware {
  readonly id = ++counterInstances

  handle(ctx: Context, next: Next): void {
    ctx.header('x-instance', String(this.id))
    next()
  }
}

function newApp(configure: (container: CaffeineIoC) => void = () => {}) {
  const container = new CaffeineIoC()
  configure(container)
  return createWebApplication(fastifyAdapterFactory(fastify()), { container })
}

describe('middleware pipeline', () => {
  it('runs a function middleware before the handler', async () => {
    const seen: string[] = []

    const app = newApp().build()
    app.use((_ctx, next) => {
      seen.push('mw')
      next()
    })
    await app.ready()

    const res = await app.fetch('/mw/echo')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(seen).toEqual(['mw'])
    await app.close()
  })

  it('lets the controller error handler see an error a handler-group middleware threw', async () => {
    const app = newApp().build()
    app.use(() => {
      throw new ErrMiddlewareFailed('middleware exploded')
    })
    await app.ready()

    const res = await app.fetch('/mw-catch')

    // The handler group wraps the controller dispatch, so the throw happens inside the controller's own
    // encapsulated error handler rather than at server level.
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ by: 'controller', error: 'middleware exploded' })
    await app.close()
  })

  it('resolves a middleware class from the container, with its dependencies injected', async () => {
    const app = newApp(container => {
      container.bind(Tag, t => t.toValue(new Tag('injected')))
      container.bind(Tagger, t => t.toClass(Tagger, [Tag]))
    }).build()
    app.use(Tagger)
    await app.ready()

    const res = await app.fetch('/mw/echo')

    expect(res.headers.get('x-tag')).toBe('injected')
    await app.close()
  })

  it('resolves a middleware registered by container key', async () => {
    const app = newApp(container => {
      container.bind(Tag, t => t.toValue(new Tag('by-key')))
      container.bind(kTagger, t => t.toClass(Tagger, [Tag]))
    }).build()
    app.use(kTagger)
    await app.ready()

    const res = await app.fetch('/mw/echo')

    expect(res.headers.get('x-tag')).toBe('by-key')
    await app.close()
  })

  it('resolves a request-scoped middleware once per request, a singleton once for the process', async () => {
    counterInstances = 0

    const scoped = newApp(container => {
      container.bind(Counter, t => t.toClass(Counter).lifetime(Scopes.REQUEST))
    }).build()
    scoped.use(Counter)
    await scoped.ready()

    const first = await scoped.fetch('/mw/echo')
    const second = await scoped.fetch('/mw/echo')
    expect(first.headers.get('x-instance')).not.toBe(second.headers.get('x-instance'))
    await scoped.close()

    const singleton = newApp(container => {
      container.bind(Counter, t => t.toClass(Counter))
    }).build()
    singleton.use(Counter)
    await singleton.ready()

    const third = await singleton.fetch('/mw/echo')
    const fourth = await singleton.fetch('/mw/echo')
    expect(third.headers.get('x-instance')).toBe(fourth.headers.get('x-instance'))
    await singleton.close()
  })

  it('runs a hook-group middleware before a handler-group one registered earlier', async () => {
    const order: string[] = []

    const app = newApp().build()
    app.use((_ctx, next) => {
      order.push('handler-group')
      next()
    })
    app.use((_ctx, next) => {
      order.push('onRequest')
      next()
    }, 'onRequest')
    await app.ready()

    await app.fetch('/mw/echo')

    expect(order).toEqual(['onRequest', 'handler-group'])
    await app.close()
  })

  it('short-circuits from a hook group, skipping the handler group and the handler', async () => {
    const reached: string[] = []

    const app = newApp().build()
    app.use((_ctx, next) => {
      reached.push('handler-group')
      next()
    })
    app.use(ctx => {
      ctx.status(401).body({ error: 'anonymous' })
    }, 'onRequest')
    await app.ready()

    const res = await app.fetch('/mw/echo')

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'anonymous' })
    expect(reached).toEqual([])
    await app.close()
  })

  it('leaves a reply a hook-group middleware answered itself alone', async () => {
    const app = newApp().build()
    app.use(ctx => {
      ctx.status(418).body({ answered: 'directly' })
    }, 'onRequest')
    await app.ready()

    const res = await app.fetch('/mw/echo')

    expect(res.status).toBe(418)
    expect(await res.json()).toEqual({ answered: 'directly' })
    await app.close()
  })

  it('refuses a registration after the application is ready', async () => {
    const app = newApp().build()
    await app.ready()

    expect(() => app.use((_ctx, next) => next())).toThrow(ErrPipelineSealed)
    await app.close()
  })
})
