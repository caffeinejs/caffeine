import type { Ctor, Provider } from '@caffeinejs/di'
import { Injectable, Lifetime, Named, Primary, Scopes, token } from '@caffeinejs/di'
import { $t } from '@caffeinejs/std'
import fastify from 'fastify'
import { describe, it, expect } from 'vitest'

import {
  Catch,
  CatchWith,
  type Context,
  Controller,
  ErrHTTPNotFound,
  ErrorHandler,
  ErrorHandlerProvider,
  Get,
  Args,
  Post,
  Schema,
  createWebApplication,
  fastifyAdapterFactory,
  $p,
} from '../index.js'
import { ErrHTTPBadRequest, ErrHTTPConflict, ErrHTTP } from './http.js'

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
    const provider = new ErrorHandlerProvider(mapOf([ErrHTTPNotFound, p]))

    expect(provider.provide(new ErrHTTPNotFound())).toBe(p)
  })

  it('walks the prototype chain to a base-class handler', () => {
    const p = providerOf('http')
    const provider = new ErrorHandlerProvider(mapOf([ErrHTTP, p]))

    // ErrHTTPNotFound extends ErrHTTP — the base handler serves the subclass.
    expect(provider.provide(new ErrHTTPNotFound())).toBe(p)
  })

  it('prefers the most specific handler over a base handler', () => {
    const specific = providerOf('notFound')
    const base = providerOf('http')
    const provider = new ErrorHandlerProvider(mapOf([ErrHTTP, base], [ErrHTTPNotFound, specific]))

    expect(provider.provide(new ErrHTTPNotFound())).toBe(specific)
    expect(provider.provide(new ErrHTTPBadRequest())).toBe(base)
  })

  it('treats a handler registered for Error as a catch-all', () => {
    const p = providerOf('all')
    const provider = new ErrorHandlerProvider(mapOf([Error as Ctor<Error>, p]))

    expect(provider.provide(new ErrHTTPNotFound())).toBe(p)
    expect(provider.provide(new Error('x'))).toBe(p)
    expect(provider.provide(new TypeError('x'))).toBe(p)
  })

  it('returns undefined when nothing matches', () => {
    const provider = new ErrorHandlerProvider(mapOf())

    expect(provider.provide(new ErrHTTPNotFound())).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Integration — dispatch through the app. A specific @Catch(ErrHTTPNotFound)
// handler and a @Catch(Error) catch-all coexist without conflict.
// ---------------------------------------------------------------------------

@Injectable()
class Greeter {
  greet(): string {
    return 'handled'
  }
}

// @Catch composes @Injectable: the [Greeter] dependency is injected into the handler.
@Catch(ErrHTTPNotFound, [Greeter])
class NotFoundHandler extends ErrorHandler<ErrHTTPNotFound> {
  constructor(private readonly greeter: Greeter) {
    super()
  }

  async handle(ctx: Context, error: ErrHTTPNotFound): Promise<void> {
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
  @Args([$p.param('id')])
  get(id: string): unknown {
    throw new ErrHTTPNotFound(`Pet "${id}" not found`)
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
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
    await app.ready()

    const res = await app.fetch('/pets/42')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Pet "42" not found', via: 'handled' })
  })

  it('routes an arbitrary Error to the @Catch(Error) catch-all', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
    await app.ready()

    const res = await app.fetch('/boom')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ caught: 'kaboom' })
  })
})

// ---------------------------------------------------------------------------
// Integration — per-controller @Catch methods.
// The global NotFoundHandler / CatchAllHandler above act as the fallback layer.
// ---------------------------------------------------------------------------

// Controller-scoped handler wins over the global @Catch(ErrHTTPNotFound) class for this controller.
@Controller('/shop')
class ShopController {
  @Get('/:id')
  @Args([$p.param('id')])
  get(id: string): unknown {
    throw new ErrHTTPNotFound(`item ${id}`)
  }

  @Catch(ErrHTTPNotFound)
  async onNotFound(ctx: Context, error: ErrHTTPNotFound): Promise<void> {
    ctx.status(404).body({ scoped: true, error: error.message })
  }
}

// A base-type handler catches subclasses (ErrHTTPConflict extends ErrHTTP).
@Controller('/widgets')
class WidgetsController {
  @Get('/conflict')
  conflict(): unknown {
    throw new ErrHTTPConflict('dup')
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

  @Catch(ErrHTTPNotFound)
  async onNotFound(ctx: Context, _error: ErrHTTPNotFound): Promise<void> {
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
    throw new ErrHTTPNotFound('x')
  }

  @Catch(ErrHTTPNotFound)
  async onNotFound(ctx: Context, _error: ErrHTTPNotFound): Promise<void> {
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
    throw new ErrHTTPNotFound('x')
  }

  @Catch(ErrHTTPNotFound)
  async onNotFound(ctx: Context, _error: ErrHTTPNotFound): Promise<void> {
    ctx.status(404).body({ marker: this.marker })
  }
}
// A schema-validation failure fires before the route handler runs. The controller's @Catch(Error)
// must still render it — the encapsulated error handler covers every phase, not just the handler body.
@Controller('/validated')
class ValidatedController {
  @Post('/')
  @Schema({ body: $t.Object({ name: $t.String() }) })
  @Args([$p.body()])
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
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
    await app.ready()

    const res = await app.fetch('/shop/9')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ scoped: true, error: 'item 9' })
  })

  it('catches subclasses via a base-type @Catch method', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
    await app.ready()

    const res = await app.fetch('/widgets/conflict')

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ http: 'dup' })
  })

  it('falls back to the global handler for an uncovered error type', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
    await app.ready()

    const res = await app.fetch('/mixed/other')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ caught: 'plain' })
  })

  it('runs on the same request-scoped instance that threw', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
    await app.ready()

    const res = await app.fetch('/scoped/boom')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ marker: 'touched' })
  })

  it('runs on the same transient instance that threw', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
    await app.ready()

    const res = await app.fetch('/tx/boom')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ marker: 'touched' })
  })

  it('catches a schema-validation error thrown before the route handler', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
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

// ---------------------------------------------------------------------------
// Integration — multi-type @Catch and @CatchWith. Uses its own error hierarchy so
// these handlers never overlap the ErrHTTP ones above; the @Catch(Error)
// CatchAllHandler stays the last resort for everything declared here.
// ---------------------------------------------------------------------------

class ErrAlpha extends Error {}
class ErrBeta extends ErrAlpha {}
class ErrGamma extends Error {}
class ErrDelta extends Error {}

@Injectable()
class Marker {
  value(): string {
    return 'marked'
  }
}

// A single class declaring several error types. Global by default.
@Catch([ErrAlpha, ErrGamma])
class AlphaGammaHandler extends ErrorHandler<ErrAlpha | ErrGamma> {
  async handle(ctx: Context, error: ErrAlpha | ErrGamma): Promise<void> {
    ctx.status(500).body({ by: 'global', error: error.message })
  }
}

// Same error type as the global handler above, but excluded from the global map — reachable only
// through @CatchWith. Without { global: false } this would fail the app build as an ambiguous handler.
@Catch(ErrAlpha, [Marker], { global: false })
class ControllerAlphaHandler extends ErrorHandler<ErrAlpha> {
  constructor(private readonly marker: Marker) {
    super()
  }

  async handle(ctx: Context, error: ErrAlpha): Promise<void> {
    ctx.status(400).body({ by: 'controller', via: this.marker.value(), error: error.message })
  }
}

@Catch(ErrAlpha, { global: false })
class RouteAlphaHandler extends ErrorHandler<ErrAlpha> {
  async handle(ctx: Context, error: ErrAlpha): Promise<void> {
    ctx.status(402).body({ by: 'route', error: error.message })
  }
}

@Catch(Error, { global: false })
class ValidationHandler extends ErrorHandler<Error> {
  async handle(ctx: Context, _error: Error): Promise<void> {
    ctx.status(422).body({ by: 'route-validation' })
  }
}

// Two handlers share a name; @Primary decides which one @CatchWith(token<ErrorHandler<Error>>('deltaHandler')) resolves.
@Named('deltaHandler')
@Catch(ErrDelta, { global: false })
class DeltaFallbackHandler extends ErrorHandler<ErrDelta> {
  async handle(ctx: Context, _error: ErrDelta): Promise<void> {
    ctx.status(500).body({ by: 'fallback' })
  }
}

@Primary()
@Named('deltaHandler')
@Catch(ErrDelta, { global: false })
class DeltaPrimaryHandler extends ErrorHandler<ErrDelta> {
  async handle(ctx: Context, _error: ErrDelta): Promise<void> {
    ctx.status(409).body({ by: 'primary' })
  }
}

void [Marker, AlphaGammaHandler, ControllerAlphaHandler, RouteAlphaHandler]
void [ValidationHandler, DeltaFallbackHandler, DeltaPrimaryHandler]

@Controller('/multi')
class MultiTypeController {
  @Get('/alpha')
  alpha(): unknown {
    throw new ErrAlpha('alpha')
  }

  @Get('/gamma')
  gamma(): unknown {
    throw new ErrGamma('gamma')
  }

  @Get('/beta')
  beta(): unknown {
    throw new ErrBeta('beta')
  }
}

// The controller-level @CatchWith overrides the global handler; the route-level one overrides both.
// The @Catch method covers a type neither @CatchWith declares.
@CatchWith(ControllerAlphaHandler)
@Controller('/cb-shop')
class CatchByShopController {
  @Get('/alpha')
  alpha(): unknown {
    throw new ErrAlpha('shop alpha')
  }

  @Get('/override')
  @CatchWith(RouteAlphaHandler)
  override(): unknown {
    throw new ErrAlpha('shop override')
  }

  @Get('/gamma')
  gamma(): unknown {
    throw new ErrGamma('shop gamma')
  }

  @Catch(ErrGamma)
  async onGamma(ctx: Context, error: ErrGamma): Promise<void> {
    ctx.status(404).body({ by: 'method', error: error.message })
  }
}

// @CatchWith wins over a @Catch method for the same error type.
@CatchWith(ControllerAlphaHandler)
@Controller('/cb-priority')
class CatchByPriorityController {
  @Get('/alpha')
  alpha(): unknown {
    throw new ErrAlpha('priority alpha')
  }

  @Catch(ErrAlpha)
  async onAlpha(ctx: Context, _error: ErrAlpha): Promise<void> {
    ctx.status(404).body({ by: 'method' })
  }
}

@CatchWith(token<ErrorHandler<Error>>('deltaHandler'))
@Controller('/cb-named')
class CatchByNamedController {
  @Get('/delta')
  delta(): unknown {
    throw new ErrDelta('delta')
  }
}

// A schema-validation failure fires before the route handler runs. A route-level @CatchWith must still
// render it — routeOptions is resolved before validation, so the route's handler map is reachable.
@Controller('/cb-validated')
class CatchByValidatedController {
  @Post('/')
  @CatchWith(ValidationHandler)
  @Schema({ body: $t.Object({ name: $t.String() }) })
  @Args([$p.body()])
  create(body: unknown): unknown {
    return { created: body }
  }
}

// Same error type, no @CatchWith: the non-global ErrDelta handlers must not be reachable from here.
@Controller('/cb-orphan')
class CatchByOrphanController {
  @Get('/delta')
  delta(): unknown {
    throw new ErrDelta('orphan delta')
  }
}

void [MultiTypeController, CatchByShopController, CatchByPriorityController]
void [CatchByNamedController, CatchByValidatedController, CatchByOrphanController]

describe('@Catch with multiple error types', () => {
  it('serves every declared error type from one handler class', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
    await app.ready()

    const alpha = await app.fetch('/multi/alpha')
    const gamma = await app.fetch('/multi/gamma')

    expect(alpha.status).toBe(500)
    expect(await alpha.json()).toEqual({ by: 'global', error: 'alpha' })
    expect(gamma.status).toBe(500)
    expect(await gamma.json()).toEqual({ by: 'global', error: 'gamma' })
  })

  it('serves subclasses of a declared error type', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
    await app.ready()

    const res = await app.fetch('/multi/beta')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ by: 'global', error: 'beta' })
  })
})

describe('@CatchWith', () => {
  it('overrides the global handler for the controller, with dependencies injected', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
    await app.ready()

    const res = await app.fetch('/cb-shop/alpha')

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ by: 'controller', via: 'marked', error: 'shop alpha' })
  })

  it('overrides the controller handler on a single route', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
    await app.ready()

    const res = await app.fetch('/cb-shop/override')

    expect(res.status).toBe(402)
    expect(await res.json()).toEqual({ by: 'route', error: 'shop override' })
  })

  it('leaves error types it does not declare to the @Catch method', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
    await app.ready()

    const res = await app.fetch('/cb-shop/gamma')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ by: 'method', error: 'shop gamma' })
  })

  it('wins over a @Catch method registered for the same error type', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
    await app.ready()

    const res = await app.fetch('/cb-priority/alpha')

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ by: 'controller', via: 'marked', error: 'priority alpha' })
  })

  it('catches a schema-validation error from a route-level handler', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
    await app.ready()

    const res = await app.fetch('/cb-validated', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ by: 'route-validation' })
  })

  it('resolves a handler by @Named identifier, honouring @Primary', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
    await app.ready()

    const res = await app.fetch('/cb-named/delta')

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ by: 'primary' })
  })

  it('keeps a non-global handler out of the application-wide map', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
    await app.ready()

    // ErrDelta is served only by handlers marked { global: false }. A controller that does not name
    // them cannot reach them: the lookup falls through to the global @Catch(Error) catch-all.
    const res = await app.fetch('/cb-orphan/delta')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ caught: 'orphan delta' })
  })
})
