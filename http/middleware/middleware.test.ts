import { CaffeineIoC, Scopes, token } from '@caffeinejs/di'
import cors from 'cors'
import fastify from 'fastify'
import { describe, it, expect } from 'vitest'

import {
  type Context,
  Controller,
  ErrPipelineSealed,
  Get,
  type Middleware,
  type MiddlewareHook,
  type Next,
  Router,
  createWebApplication,
  fastifyAdapterFactory,
  kMiddlewareHook,
} from '../index.js'

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

  it('runs an onRequest middleware before a preHandler one', async () => {
    const order: string[] = []

    const app = newApp().build()
    app.use((_ctx, next) => {
      order.push('onRequest')
      next()
    })
    app.use(
      (_ctx, next) => {
        order.push('preHandler')
        next()
      },
      { hook: 'preHandler' },
    )
    await app.ready()

    await app.fetch('/mw/echo')

    expect(order).toEqual(['onRequest', 'preHandler'])
    await app.close()
  })

  it('short-circuits from onRequest, skipping later middleware and the handler', async () => {
    const reached: string[] = []

    const app = newApp().build()
    app.use(
      (_ctx, next) => {
        reached.push('preHandler')
        next()
      },
      { hook: 'preHandler' },
    )
    app.use((ctx, _next) => {
      ctx.status(401).body({ error: 'anonymous' })
    })
    await app.ready()

    const res = await app.fetch('/mw/echo')

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'anonymous' })
    expect(reached).toEqual([])
    await app.close()
  })

  it('leaves a reply a middleware answered itself alone', async () => {
    const app = newApp().build()
    app.use((ctx, _next) => {
      ctx.status(418).body({ answered: 'directly' })
    })
    await app.ready()

    const res = await app.fetch('/mw/echo')

    expect(res.status).toBe(418)
    expect(await res.json()).toEqual({ answered: 'directly' })
    await app.close()
  })

  it('answers with CORS headers from Node cors() and still runs the handler', async () => {
    const app = newApp().build()
    app.use(cors({ origin: 'http://example.com' }))
    await app.ready()

    const res = await app.fetch('/mw/echo', { headers: { Origin: 'http://example.com' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://example.com')
    expect(await res.json()).toEqual({ ok: true })
    await app.close()
  })

  it('restricts Node cors() to a path prefix', async () => {
    const app = newApp().build()
    app.mount(new Router('/api').get('/echo', () => ({ ok: true })))
    app.use('/api', cors({ origin: 'http://example.com' }))
    await app.ready()

    const inside = await app.fetch('/api/echo', { headers: { Origin: 'http://example.com' } })
    const outside = await app.fetch('/mw/echo', { headers: { Origin: 'http://example.com' } })

    expect(inside.status).toBe(200)
    expect(inside.headers.get('access-control-allow-origin')).toBe('http://example.com')
    expect(outside.status).toBe(200)
    expect(outside.headers.get('access-control-allow-origin')).toBeNull()
    await app.close()
  })

  it('refuses a registration after the application is ready', async () => {
    const app = newApp().build()
    await app.ready()

    expect(() => app.use((_ctx, next) => next())).toThrow(ErrPipelineSealed)
    await app.close()
  })

  it('runs a class at its hinted hook when use() omits { hook }', async () => {
    const order: string[] = []

    class Hinted implements Middleware {
      static get [kMiddlewareHook](): MiddlewareHook {
        return 'preHandler'
      }

      handle(_ctx: Context, next: Next): void {
        order.push('hinted')
        next()
      }
    }

    const app = newApp(container => {
      container.bind(Hinted, t => t.toClass(Hinted))
    }).build()
    app.use((_ctx, next) => {
      order.push('onRequest')
      next()
    })
    app.use(Hinted)
    await app.ready()

    await app.fetch('/mw/echo')

    expect(order).toEqual(['onRequest', 'hinted'])
    await app.close()
  })

  it('runs a hinted class at onRequest when { hook } overrides the getter', async () => {
    const order: string[] = []

    class Hinted implements Middleware {
      static get [kMiddlewareHook](): MiddlewareHook {
        return 'preHandler'
      }

      handle(_ctx: Context, next: Next): void {
        order.push('hinted')
        next()
      }
    }

    const app = newApp(container => {
      container.bind(Hinted, t => t.toClass(Hinted))
    }).build()
    app.use(Hinted, { hook: 'onRequest' })
    app.use((_ctx, next) => {
      order.push('second')
      next()
    })
    await app.ready()

    await app.fetch('/mw/echo')

    expect(order).toEqual(['hinted', 'second'])
    await app.close()
  })
})
