import { describe, it, expect } from 'vitest'
import { CaffeineIoC, Scopes, token } from '@caffeinejs/di'
import fastify from 'fastify'
import {
  type ActionResult,
  Catch,
  type Context,
  Controller,
  ErrPipelineSealed,
  Get,
  Middleware,
  type MiddlewareSetupContext,
  type Next,
  Responder,
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

  @Get('/boom')
  boom(): never {
    throw new Error('handler exploded')
  }

  @Get('/responder')
  responder() {
    return new (class extends Responder {
      respond(ctx: Context) {
        ctx.header('x-responder', 'yes')
        return { rendered: true }
      }
    })()
  }
}
void [MiddlewareController]

const kTagger = token<any>(Symbol('tagger'))

class Tag {
  constructor(readonly value: string) {}
}

/** Wraps whatever the controller returned — the reason the `handler` group exists. */
class Envelope extends Middleware {
  async handle(_ctx: Context, next: Next): Promise<unknown> {
    return { data: await next() }
  }
}

/** A middleware with an injected dependency, which is the point of the class form. */
class Tagger extends Middleware {
  constructor(private readonly tag: Tag) {
    super()
  }

  async handle(ctx: Context, next: Next): Promise<unknown> {
    ctx.header('x-tag', this.tag.value)
    return next()
  }
}

let counterInstances = 0

class Counter extends Middleware {
  readonly id = ++counterInstances

  async handle(ctx: Context, next: Next): Promise<unknown> {
    ctx.header('x-instance', String(this.id))
    return next()
  }
}

function newApp(configure: (container: CaffeineIoC) => void = () => {}) {
  const container = new CaffeineIoC()
  configure(container)
  return createWebApplication(fastifyAdapterFactory(fastify()), { container })
}

describe('middleware pipeline', () => {
  it('runs a function middleware around the handler', async () => {
    const seen: string[] = []

    const app = newApp().build()
    app.use(async (_ctx, next) => {
      seen.push('in')
      const result = await next()
      seen.push('out')
      return result
    })
    await app.ready()

    const res = await app.fetch('/mw/echo')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(seen).toEqual(['in', 'out'])
    await app.close()
  })

  it('rewrites the value the controller returned', async () => {
    const app = newApp().build()
    app.use(new Envelope())
    await app.ready()

    const res = await app.fetch('/mw/echo')

    expect(await res.json()).toEqual({ data: { ok: true } })
    await app.close()
  })

  it('sees the Responder a controller returned, and can let it render', async () => {
    let observed: unknown
    const app = newApp().build()
    app.use(async (_ctx, next) => {
      observed = await next()
      return observed
    })
    await app.ready()

    const res = await app.fetch('/mw/responder')

    expect(observed).toBeInstanceOf(Responder)
    expect(res.headers.get('x-responder')).toBe('yes')
    expect(await res.json()).toEqual({ rendered: true })
    await app.close()
  })

  it('catches an exception thrown by the controller', async () => {
    const app = newApp().build()
    app.use(async (ctx, next) => {
      try {
        return await next()
      } catch (error) {
        ctx.status(503)
        return { recovered: (error as Error).message }
      }
    })
    await app.ready()

    const res = await app.fetch('/mw/boom')

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ recovered: 'handler exploded' })
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
      container.bind(Tag).toValue(new Tag('injected'))
      container.bind(Tagger).toClass(Tagger, [Tag])
    }).build()
    app.use(Tagger)
    await app.ready()

    const res = await app.fetch('/mw/echo')

    expect(res.headers.get('x-tag')).toBe('injected')
    await app.close()
  })

  it('resolves a middleware registered by container key', async () => {
    const app = newApp(container => {
      container.bind(Tag).toValue(new Tag('by-key'))
      container.bind(kTagger).toClass(Tagger, [Tag])
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
      container.bind(Counter).toClass(Counter).lifetime(Scopes.REQUEST)
    }).build()
    scoped.use(Counter)
    await scoped.ready()

    const first = await scoped.fetch('/mw/echo')
    const second = await scoped.fetch('/mw/echo')
    expect(first.headers.get('x-instance')).not.toBe(second.headers.get('x-instance'))
    await scoped.close()

    const singleton = newApp(container => {
      container.bind(Counter).toClass(Counter)
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
      return next()
    })
    app.use((_ctx, next) => {
      order.push('onRequest')
      return next()
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
      return next()
    })
    app.use(ctx => {
      ctx.status(401)
      return { error: 'anonymous' }
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

  it('runs setup() once at start-up, with the resolved application', async () => {
    const calls: MiddlewareSetupContext[] = []

    class Setups extends Middleware {
      setup(ctx: MiddlewareSetupContext): void {
        calls.push(ctx)
      }

      handle(_ctx: Context, next: Next): ActionResult {
        return next()
      }
    }

    const app = newApp().build()
    app.use(new Setups())
    await app.ready()

    await app.fetch('/mw/echo')
    await app.fetch('/mw/echo')

    expect(calls).toHaveLength(1)
    expect(calls[0].routeGroups.length).toBeGreaterThan(0)
    await app.close()
  })

  it('fails start-up when setup() throws', async () => {
    class Refuses extends Middleware {
      setup(): void {
        throw new Error('this middleware cannot work here')
      }

      handle(_ctx: Context, next: Next): ActionResult {
        return next()
      }
    }

    const app = newApp().build()
    app.use(new Refuses())

    await expect(app.ready()).rejects.toThrow('this middleware cannot work here')
  })

  it('refuses a registration after the application is ready', async () => {
    const app = newApp().build()
    await app.ready()

    expect(() => app.use((_ctx, next) => next())).toThrow(ErrPipelineSealed)
    await app.close()
  })
})
