import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import { Injectable, Named, Primary } from '@caffeinejs/di'
import { Catch, CatchBy, type Context, Controller, ErrorHandler, Get, Params, Post, Schema, createWebApplication, fastifyAdapterFactory, $p } from '../index.js'

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
// through @CatchBy. Without { global: false } this would fail the app build as an ambiguous handler.
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

// Two handlers share a name; @Primary decides which one @CatchBy('deltaHandler') resolves.
@Catch(Error, { global: false })
class ValidationHandler extends ErrorHandler<Error> {
  async handle(ctx: Context, _error: Error): Promise<void> {
    ctx.status(422).body({ by: 'route-validation' })
  }
}

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

@Controller('/plain')
class PlainController {
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

// The controller-level @CatchBy overrides the global handler; the route-level one overrides both.
// The @Catch method covers a type neither @CatchBy declares.
@CatchBy(ControllerAlphaHandler)
@Controller('/shop')
class ShopController {
  @Get('/alpha')
  alpha(): unknown {
    throw new ErrAlpha('shop alpha')
  }

  @Get('/override')
  @CatchBy(RouteAlphaHandler)
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

// @CatchBy wins over a @Catch method for the same error type.
@CatchBy(ControllerAlphaHandler)
@Controller('/priority')
class PriorityController {
  @Get('/alpha')
  alpha(): unknown {
    throw new ErrAlpha('priority alpha')
  }

  @Catch(ErrAlpha)
  async onAlpha(ctx: Context, _error: ErrAlpha): Promise<void> {
    ctx.status(404).body({ by: 'method' })
  }
}

@CatchBy('deltaHandler')
@Controller('/named')
class NamedController {
  @Get('/delta')
  delta(): unknown {
    throw new ErrDelta('delta')
  }
}

// A schema-validation failure fires before the route handler runs. A route-level @CatchBy must still
// render it — routeOptions is resolved before validation, so the route's handler map is reachable.
@Controller('/validated')
class ValidatedController {
  @Post('/')
  @CatchBy(ValidationHandler)
  @Schema({ body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } })
  @Params([$p.body()])
  create(body: unknown): unknown {
    return { created: body }
  }
}

// Same error type, no @CatchBy: the non-global ErrDelta handlers must not be reachable from here.
@Controller('/orphan')
class OrphanController {
  @Get('/delta')
  delta(): unknown {
    throw new ErrDelta('orphan delta')
  }
}

void [PlainController, ShopController, PriorityController, NamedController, ValidatedController, OrphanController]

describe('@Catch with multiple error types', () => {
  it('serves every declared error type from one handler class', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const alpha = await app.fetch('/plain/alpha')
    const gamma = await app.fetch('/plain/gamma')

    expect(alpha.status).toBe(500)
    expect(await alpha.json()).toEqual({ by: 'global', error: 'alpha' })
    expect(gamma.status).toBe(500)
    expect(await gamma.json()).toEqual({ by: 'global', error: 'gamma' })
  })

  it('serves subclasses of a declared error type', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/plain/beta')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ by: 'global', error: 'beta' })
  })
})

describe('@CatchBy', () => {
  it('overrides the global handler for the controller, with dependencies injected', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/shop/alpha')

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ by: 'controller', via: 'marked', error: 'shop alpha' })
  })

  it('overrides the controller handler on a single route', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/shop/override')

    expect(res.status).toBe(402)
    expect(await res.json()).toEqual({ by: 'route', error: 'shop override' })
  })

  it('leaves error types it does not declare to the @Catch method', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/shop/gamma')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ by: 'method', error: 'shop gamma' })
  })

  it('wins over a @Catch method registered for the same error type', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/priority/alpha')

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ by: 'controller', via: 'marked', error: 'priority alpha' })
  })

  it('catches a schema-validation error from a route-level handler', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/validated', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ by: 'route-validation' })
  })

  it('resolves a handler by @Named identifier, honouring @Primary', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/named/delta')

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ by: 'primary' })
  })

  it('keeps a non-global handler out of the application-wide map', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    // ErrDelta is served only by handlers marked { global: false }. A controller that does not name
    // them falls through to the global map — which has no entry — and lands on Fastify's default.
    const res = await app.fetch('/orphan/delta')

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'Internal Server Error' })
  })
})
