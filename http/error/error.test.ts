import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import type { Ctor, Provider } from '@caffeinejs/di'
import { Injectable, Lifetime, Scopes } from '@caffeinejs/di'
import { Catch, type Context, Controller, ErrNotFound, ErrorHandler, ErrorHandlerProvider, Get, Params, Post, Schema, createWebApplication, fastifyAdapterFactory, $p } from '../index.js'
import { ErrBadRequest, ErrConflict, ErrHTTP } from './http.js'

// ---------------------------------------------------------------------------
// Unit — ErrorHandlerProvider.handlerFor (no container, no registry)
// ---------------------------------------------------------------------------

class Recorder extends ErrorHandler<Error> {
  constructor(readonly label: string) {
    super()
  }

  async handle(_ctx: Context, _error: Error): Promise<void> {}
}

function providerOf(label: string): Provider<ErrorHandler<Error>> {
  const handler = new Recorder(label)
  return { get: () => handler } as Provider<ErrorHandler<Error>>
}

function mapOf(...entries: Array<[Ctor<Error>, Provider<ErrorHandler<Error>>]>) {
  return new Map<Ctor<Error>, Provider<ErrorHandler<Error>>>(entries)
}

describe('ErrorHandlerProvider', () => {
  it('returns the exact handler for the error class', () => {
    const p = providerOf('notFound')
    const provider = new ErrorHandlerProvider(mapOf([ErrNotFound, p]))

    expect(provider.handlerFor(new ErrNotFound())).toBe(p)
  })

  it('walks the prototype chain to a base-class handler', () => {
    const p = providerOf('http')
    const provider = new ErrorHandlerProvider(mapOf([ErrHTTP, p]))

    // ErrNotFound extends ErrHTTP — the base handler serves the subclass.
    expect(provider.handlerFor(new ErrNotFound())).toBe(p)
  })

  it('prefers the most specific handler over a base handler', () => {
    const specific = providerOf('notFound')
    const base = providerOf('http')
    const provider = new ErrorHandlerProvider(mapOf([ErrHTTP, base], [ErrNotFound, specific]))

    expect(provider.handlerFor(new ErrNotFound())).toBe(specific)
    expect(provider.handlerFor(new ErrBadRequest())).toBe(base)
  })

  it('treats a handler registered for Error as a catch-all', () => {
    const p = providerOf('all')
    const provider = new ErrorHandlerProvider(mapOf([Error as Ctor<Error>, p]))

    expect(provider.handlerFor(new ErrNotFound())).toBe(p)
    expect(provider.handlerFor(new Error('x'))).toBe(p)
    expect(provider.handlerFor(new TypeError('x'))).toBe(p)
  })

  it('returns undefined when nothing matches', () => {
    const provider = new ErrorHandlerProvider(mapOf())

    expect(provider.handlerFor(new ErrNotFound())).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Integration — dispatch through the app. A specific @Catch(ErrNotFound)
// handler and a @Catch(Error) catch-all coexist without conflict.
// ---------------------------------------------------------------------------

@Injectable()
class Greeter {
  greet(): string {
    return 'handled'
  }
}

// @Catch composes @Injectable: the [Greeter] dependency is injected into the handler.
@Catch(ErrNotFound, [Greeter])
class NotFoundHandler extends ErrorHandler<ErrNotFound> {
  constructor(private readonly greeter: Greeter) {
    super()
  }

  async handle(ctx: Context, error: ErrNotFound): Promise<void> {
    ctx.status(404).body({ error: error.message, via: this.greeter.greet() })
  }
}

@Catch(Error)
class CatchAllHandler extends ErrorHandler<Error> {
  async handle(ctx: Context, error: Error): Promise<void> {
    ctx.status(500).body({ caught: error.message })
  }
}

void [Greeter, NotFoundHandler, CatchAllHandler]

@Controller('/pets')
class PetsController {
  @Get('/:id')
  @Params([$p.param('id')])
  get(id: string): unknown {
    throw new ErrNotFound(`Pet "${id}" not found`)
  }
}

@Controller('/boom')
class BoomController {
  @Get('/')
  boom(): unknown {
    throw new Error('kaboom')
  }
}

void [PetsController, BoomController]

describe('error handler dispatch', () => {
  it('renders the matching @Catch handler with injected dependencies', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/pets/42')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Pet "42" not found', via: 'handled' })
  })

  it('routes an arbitrary Error to the @Catch(Error) catch-all', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/boom')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ caught: 'kaboom' })
  })
})

// ---------------------------------------------------------------------------
// Integration — per-controller @Catch methods (Spring @ExceptionHandler style).
// The global NotFoundHandler / CatchAllHandler above act as the fallback layer.
// ---------------------------------------------------------------------------

// Controller-scoped handler wins over the global @Catch(ErrNotFound) class for this controller.
@Controller('/shop')
class ShopController {
  @Get('/:id')
  @Params([$p.param('id')])
  get(id: string): unknown {
    throw new ErrNotFound(`item ${id}`)
  }

  @Catch(ErrNotFound)
  async onNotFound(ctx: Context, error: ErrNotFound): Promise<void> {
    ctx.status(404).body({ scoped: true, error: error.message })
  }
}

// A base-type handler catches subclasses (ErrConflict extends ErrHTTP).
@Controller('/widgets')
class WidgetsController {
  @Get('/conflict')
  conflict(): unknown {
    throw new ErrConflict('dup')
  }

  @Catch(ErrHTTP)
  async onHttp(ctx: Context, error: ErrHTTP): Promise<void> {
    ctx.status(error.statusCode).body({ http: error.message })
  }
}

// The controller declares a handler for a type it does not throw here → falls back to global.
@Controller('/mixed')
class MixedController {
  @Get('/other')
  other(): unknown {
    throw new Error('plain')
  }

  @Catch(ErrNotFound)
  async onNotFound(ctx: Context, _error: ErrNotFound): Promise<void> {
    ctx.status(404).body({ nf: true })
  }
}

// Request-scoped: a fresh instance per request. The handler must run on the SAME instance that threw.
@Lifetime(Scopes.REQUEST)
@Controller('/scoped')
class ScopedController {
  marker = 'init'

  @Get('/boom')
  boom(): unknown {
    this.marker = 'touched'
    throw new ErrNotFound('x')
  }

  @Catch(ErrNotFound)
  async onNotFound(ctx: Context, _error: ErrNotFound): Promise<void> {
    ctx.status(404).body({ marker: this.marker })
  }
}

// Transient: a new instance per resolution. The handler must run on the SAME instance that threw —
// a second controller.get() would mint a different one with marker still 'init'.
@Lifetime(Scopes.TRANSIENT)
@Controller('/tx')
class TxController {
  marker = 'init'

  @Get('/boom')
  boom(): unknown {
    this.marker = 'touched'
    throw new ErrNotFound('x')
  }

  @Catch(ErrNotFound)
  async onNotFound(ctx: Context, _error: ErrNotFound): Promise<void> {
    ctx.status(404).body({ marker: this.marker })
  }
}
// A schema-validation failure fires before the route handler runs. The controller's @Catch(Error)
// must still render it — the encapsulated error handler covers every phase, not just the handler body.
@Controller('/validated')
class ValidatedController {
  @Post('/')
  @Schema({ body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } })
  @Params([$p.body()])
  create(body: unknown): unknown {
    return { created: body }
  }

  @Catch(Error)
  async onError(ctx: Context, _error: Error): Promise<void> {
    ctx.status(400).body({ handledByController: true })
  }
}
void [ShopController, WidgetsController, MixedController, ScopedController, TxController, ValidatedController]

describe('per-controller error handler', () => {
  it('wins over a global handler for the same error type', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/shop/9')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ scoped: true, error: 'item 9' })
  })

  it('catches subclasses via a base-type @Catch method', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/widgets/conflict')

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ http: 'dup' })
  })

  it('falls back to the global handler for an uncovered error type', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/mixed/other')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ caught: 'plain' })
  })

  it('runs on the same request-scoped instance that threw', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/scoped/boom')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ marker: 'touched' })
  })

  it('runs on the same transient instance that threw', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/tx/boom')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ marker: 'touched' })
  })

  it('catches a schema-validation error thrown before the route handler', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/validated', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ handledByController: true })
  })
})
