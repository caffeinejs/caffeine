import { $t } from '@caffeinejs/application/schema'
import type { Ctor, Provider } from '@caffeinejs/di'
import { Injectable, Lifetime, Named, Primary, Scopes, token } from '@caffeinejs/di'
import { describe, it, expect } from 'vitest'

import {
  Catch,
  CatchWith,
  type IContext,
  Controller,
  ErrHTTPNotFound,
  ErrorHandler,
  ErrorHandlerProvider,
  Get,
  Args,
  type MiddlewareFn,
  Post,
  Schema,
  $p,
  type ActionResult,
} from '../../index.js'
import { createWebApplication, newRouter } from '../../platform/fastify/index.js'
import { ErrConfiguration } from './common.js'
import { ErrHTTPBadRequest, ErrHTTPConflict, ErrHTTP } from './http.js'

// ---------------------------------------------------------------------------
// Unit — ErrorHandlerProvider.handlerFor (no container, no registry)
// ---------------------------------------------------------------------------

class Recorder implements ErrorHandler<Error> {
  constructor(readonly label: string) {}

  async handle(_ctx: IContext, _error: Error): Promise<void> {}
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

// The three handlers every application below enrols. Declaring the others in this module no longer reaches
// any of them, which is what lets one file hold handlers that would otherwise collide on the same error type.
function buildApp() {
  return createWebApplication().errorHandling(e =>
    e.globalHandlers(NotFoundHandler, CatchAllHandler, AlphaGammaHandler),
  )
}

@Injectable()
class Greeter {
  greet(): string {
    return 'handled'
  }
}

// @Catch composes @Injectable: the [Greeter] dependency is injected into the handler.
@Catch(ErrHTTPNotFound, [Greeter])
class NotFoundHandler implements ErrorHandler<ErrHTTPNotFound> {
  constructor(private readonly greeter: Greeter) {}

  async handle(ctx: IContext, error: ErrHTTPNotFound): Promise<void> {
    ctx.status(404).body({ error: error.message, via: this.greeter.greet() })
  }
}

@Catch(Error)
class CatchAllHandler implements ErrorHandler<Error> {
  async handle(ctx: IContext, error: Error): Promise<void> {
    ctx.status(500).body({ caught: error.message })
  }
}

void [Greeter]

@Controller('/pets')
class PetsController {
  @Get('/:id')
  @Args([$p.param('id')])
  get(id: string): ActionResult {
    throw new ErrHTTPNotFound(`Pet "${id}" not found`)
  }
}

@Controller('/boom')
class BoomController {
  @Get('/')
  boom(): ActionResult {
    throw new Error('kaboom')
  }
}

void [PetsController, BoomController]

describe('error handler dispatch', () => {
  it('renders the matching @Catch handler with injected dependencies', async () => {
    const app = buildApp()
    await app.bootstrap()

    const res = await app.request('/pets/42')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Pet "42" not found', via: 'handled' })
  })

  it('routes an arbitrary Error to the @Catch(Error) catch-all', async () => {
    const app = buildApp()
    await app.bootstrap()

    const res = await app.request('/boom')

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
  get(id: string): ActionResult {
    throw new ErrHTTPNotFound(`item ${id}`)
  }

  @Catch(ErrHTTPNotFound)
  async onNotFound(ctx: IContext, error: ErrHTTPNotFound): Promise<void> {
    ctx.status(404).body({ scoped: true, error: error.message })
  }
}

// A base-type handler catches subclasses (ErrHTTPConflict extends ErrHTTP).
@Controller('/widgets')
class WidgetsController {
  @Get('/conflict')
  conflict(): ActionResult {
    throw new ErrHTTPConflict('dup')
  }

  @Catch(ErrHTTP)
  async onHttp(ctx: IContext, error: ErrHTTP): Promise<void> {
    ctx.status(error.statusCode).body({ http: error.message })
  }
}

// The controller declares a handler for a type it does not throw here → falls back to global.
@Controller('/mixed')
class MixedController {
  @Get('/other')
  other(): ActionResult {
    throw new Error('plain')
  }

  @Catch(ErrHTTPNotFound)
  async onNotFound(ctx: IContext, _error: ErrHTTPNotFound): Promise<void> {
    ctx.status(404).body({ nf: true })
  }
}

// Request-scoped: a fresh instance per request. The handler must run on the SAME instance that threw.
@Lifetime(Scopes.REQUEST)
@Controller('/scoped')
class ScopedController {
  marker = 'init'

  @Get('/boom')
  boom(): ActionResult {
    this.marker = 'touched'
    throw new ErrHTTPNotFound('x')
  }

  @Catch(ErrHTTPNotFound)
  async onNotFound(ctx: IContext, _error: ErrHTTPNotFound): Promise<void> {
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
  boom(): ActionResult {
    this.marker = 'touched'
    throw new ErrHTTPNotFound('x')
  }

  @Catch(ErrHTTPNotFound)
  async onNotFound(ctx: IContext, _error: ErrHTTPNotFound): Promise<void> {
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
  create(body: unknown): ActionResult {
    return { created: body }
  }

  @Catch(Error)
  async onError(ctx: IContext, _error: Error): Promise<void> {
    ctx.status(400).body({ handledByController: true })
  }
}
void [ShopController, WidgetsController, MixedController, ScopedController, TxController, ValidatedController]

describe('per-controller error handler', () => {
  it('wins over a global handler for the same error type', async () => {
    const app = buildApp()
    await app.bootstrap()

    const res = await app.request('/shop/9')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ scoped: true, error: 'item 9' })
  })

  // An application middleware runs before the controller is resolved: there is no instance for its @Catch method to
  // run on, so the error goes to the application-wide handlers, as on a route without one.
  it('leaves an error raised before the controller resolves to the global handler', async () => {
    const closed: MiddlewareFn = () => {
      throw new ErrHTTPNotFound('closed for stocktaking')
    }
    const app = buildApp().use('/shop', closed)
    await app.bootstrap()

    const res = await app.request('/shop/9')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'closed for stocktaking', via: 'handled' })
  })

  it('catches subclasses via a base-type @Catch method', async () => {
    const app = buildApp()
    await app.bootstrap()

    const res = await app.request('/widgets/conflict')

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ http: 'dup' })
  })

  it('falls back to the global handler for an uncovered error type', async () => {
    const app = buildApp()
    await app.bootstrap()

    const res = await app.request('/mixed/other')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ caught: 'plain' })
  })

  it('runs on the same request-scoped instance that threw', async () => {
    const app = buildApp()
    await app.bootstrap()

    const res = await app.request('/scoped/boom')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ marker: 'touched' })
  })

  it('runs on the same transient instance that threw', async () => {
    const app = buildApp()
    await app.bootstrap()

    const res = await app.request('/tx/boom')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ marker: 'touched' })
  })

  it('catches a schema-validation error thrown before the route handler', async () => {
    const app = buildApp()
    await app.bootstrap()

    const res = await app.request('/validated', {
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

// A single class declaring several error types, and the one of the three ErrAlpha handlers enrolled.
@Catch([ErrAlpha, ErrGamma])
class AlphaGammaHandler implements ErrorHandler<ErrAlpha | ErrGamma> {
  async handle(ctx: IContext, error: ErrAlpha | ErrGamma): Promise<void> {
    ctx.status(500).body({ by: 'global', error: error.message })
  }
}

// Same error type as the enrolled handler above. Never enrolled, so it never competes with it — it is
// reachable only through @CatchWith, and declaring it costs nothing.
@Catch(ErrAlpha, [Marker])
class ControllerAlphaHandler implements ErrorHandler<ErrAlpha> {
  constructor(private readonly marker: Marker) {}

  async handle(ctx: IContext, error: ErrAlpha): Promise<void> {
    ctx.status(400).body({ by: 'controller', via: this.marker.value(), error: error.message })
  }
}

@Catch(ErrAlpha)
class RouteAlphaHandler implements ErrorHandler<ErrAlpha> {
  async handle(ctx: IContext, error: ErrAlpha): Promise<void> {
    ctx.status(402).body({ by: 'route', error: error.message })
  }
}

@Catch(Error)
class ValidationHandler implements ErrorHandler<Error> {
  async handle(ctx: IContext, _error: Error): Promise<void> {
    ctx.status(422).body({ by: 'route-validation' })
  }
}

// Two handlers share a name; @Primary decides which one @CatchWith(token<ErrorHandler<Error>>('deltaHandler')) resolves.
@Named('deltaHandler')
@Catch(ErrDelta)
class DeltaFallbackHandler implements ErrorHandler<ErrDelta> {
  async handle(ctx: IContext, _error: ErrDelta): Promise<void> {
    ctx.status(500).body({ by: 'fallback' })
  }
}

@Primary()
@Named('deltaHandler')
@Catch(ErrDelta)
class DeltaPrimaryHandler implements ErrorHandler<ErrDelta> {
  async handle(ctx: IContext, _error: ErrDelta): Promise<void> {
    ctx.status(409).body({ by: 'primary' })
  }
}

void [Marker, ControllerAlphaHandler, RouteAlphaHandler]
void [ValidationHandler, DeltaFallbackHandler, DeltaPrimaryHandler]

@Controller('/multi')
class MultiTypeController {
  @Get('/alpha')
  alpha(): ActionResult {
    throw new ErrAlpha('alpha')
  }

  @Get('/gamma')
  gamma(): ActionResult {
    throw new ErrGamma('gamma')
  }

  @Get('/beta')
  beta(): ActionResult {
    throw new ErrBeta('beta')
  }
}

// The controller-level @CatchWith overrides the global handler; the route-level one overrides both.
// The @Catch method covers a type neither @CatchWith declares.
@CatchWith(ControllerAlphaHandler)
@Controller('/cb-shop')
class CatchByShopController {
  @Get('/alpha')
  alpha(): ActionResult {
    throw new ErrAlpha('shop alpha')
  }

  @Get('/override')
  @CatchWith(RouteAlphaHandler)
  override(): ActionResult {
    throw new ErrAlpha('shop override')
  }

  @Get('/gamma')
  gamma(): ActionResult {
    throw new ErrGamma('shop gamma')
  }

  @Catch(ErrGamma)
  async onGamma(ctx: IContext, error: ErrGamma): Promise<void> {
    ctx.status(404).body({ by: 'method', error: error.message })
  }
}

// @CatchWith wins over a @Catch method for the same error type.
@CatchWith(ControllerAlphaHandler)
@Controller('/cb-priority')
class CatchByPriorityController {
  @Get('/alpha')
  alpha(): ActionResult {
    throw new ErrAlpha('priority alpha')
  }

  @Catch(ErrAlpha)
  async onAlpha(ctx: IContext, _error: ErrAlpha): Promise<void> {
    ctx.status(404).body({ by: 'method' })
  }
}

@CatchWith(token<ErrorHandler<Error>>('deltaHandler'))
@Controller('/cb-named')
class CatchByNamedController {
  @Get('/delta')
  delta(): ActionResult {
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
  create(body: unknown): ActionResult {
    return { created: body }
  }
}

// Same error type, no @CatchWith: the unenrolled ErrDelta handlers must not be reachable from here.
@Controller('/cb-orphan')
class CatchByOrphanController {
  @Get('/delta')
  delta(): ActionResult {
    throw new ErrDelta('orphan delta')
  }
}

void [MultiTypeController, CatchByShopController, CatchByPriorityController]
void [CatchByNamedController, CatchByValidatedController, CatchByOrphanController]

describe('@Catch with multiple error types', () => {
  it('serves every declared error type from one handler class', async () => {
    const app = buildApp()
    await app.bootstrap()

    const alpha = await app.request('/multi/alpha')
    const gamma = await app.request('/multi/gamma')

    expect(alpha.status).toBe(500)
    expect(await alpha.json()).toEqual({ by: 'global', error: 'alpha' })
    expect(gamma.status).toBe(500)
    expect(await gamma.json()).toEqual({ by: 'global', error: 'gamma' })
  })

  it('serves subclasses of a declared error type', async () => {
    const app = buildApp()
    await app.bootstrap()

    const res = await app.request('/multi/beta')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ by: 'global', error: 'beta' })
  })
})

describe('@CatchWith', () => {
  it('overrides the global handler for the controller, with dependencies injected', async () => {
    const app = buildApp()
    await app.bootstrap()

    const res = await app.request('/cb-shop/alpha')

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ by: 'controller', via: 'marked', error: 'shop alpha' })
  })

  it('overrides the controller handler on a single route', async () => {
    const app = buildApp()
    await app.bootstrap()

    const res = await app.request('/cb-shop/override')

    expect(res.status).toBe(402)
    expect(await res.json()).toEqual({ by: 'route', error: 'shop override' })
  })

  it('leaves error types it does not declare to the @Catch method', async () => {
    const app = buildApp()
    await app.bootstrap()

    const res = await app.request('/cb-shop/gamma')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ by: 'method', error: 'shop gamma' })
  })

  it('wins over a @Catch method registered for the same error type', async () => {
    const app = buildApp()
    await app.bootstrap()

    const res = await app.request('/cb-priority/alpha')

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ by: 'controller', via: 'marked', error: 'priority alpha' })
  })

  it('catches a schema-validation error from a route-level handler', async () => {
    const app = buildApp()
    await app.bootstrap()

    const res = await app.request('/cb-validated', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ by: 'route-validation' })
  })

  it('resolves a handler by @Named identifier, honouring @Primary', async () => {
    const app = buildApp()
    await app.bootstrap()

    const res = await app.request('/cb-named/delta')

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ by: 'primary' })
  })

  it('keeps an unenrolled handler out of the application-wide map', async () => {
    const app = buildApp()
    await app.bootstrap()

    // ErrDelta is served only by handlers nobody enrolled. A controller that does not name them cannot
    // reach them: the lookup falls through to the enrolled @Catch(Error) catch-all.
    const res = await app.request('/cb-orphan/delta')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ caught: 'orphan delta' })
  })
})

describe('serializer', () => {
  function orders() {
    return newRouter('/orders')
      .get('/:id', () => {
        throw new ErrHTTPConflict('Order 42 is already paid')
      })
      .get('/helper/:id', ctx => {
        ctx.notFound()
      })
  }

  // A browser names text/html, so a page the application renders reaches it, and every other client keeps JSON.
  it('answers a client that asks for its media type with the page the application renders', async () => {
    const app = createWebApplication()
      .errorHandling(e =>
        e.serializer('text/html', (ctx, problem) => `<h1>${problem.status} ${problem.title}</h1><p>${ctx.req.url}</p>`),
      )
      .mount(orders())
    await app.bootstrap()

    const page = await app.request('/orders/42', { headers: { accept: 'text/html,*/*;q=0.8' } })
    expect(page.status).toBe(409)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await page.text()).toBe('<h1>409 Conflict</h1><p>/orders/42</p>')

    const helper = await app.request('/orders/helper/42', { headers: { accept: 'text/html' } })
    expect(helper.status).toBe(404)
    expect(await helper.text()).toBe('<h1>404 Not Found</h1><p>/orders/helper/42</p>')

    const api = await app.request('/orders/42')
    expect(api.headers.get('content-type')).toBe('application/json; charset=utf-8')

    await app.close()
  })

  // A page written in another encoding says so, and the server does not claim UTF-8 over it.
  it('keeps the charset a serializer was registered with', async () => {
    const app = createWebApplication()
      .errorHandling(e => e.serializer('text/plain; charset=us-ascii', (_ctx, problem) => problem.code))
      .mount(orders())
    await app.bootstrap()

    const res = await app.request('/orders/42', { headers: { accept: 'text/plain' } })

    expect(res.headers.get('content-type')).toBe('text/plain; charset=us-ascii')
    expect(await res.text()).toBe('ERR_HTTP_CONFLICT')

    await app.close()
  })

  // The built-ins are defaults, not a contract: a house Markdown layout replaces Caffeine's under the same type.
  it('replaces a built-in serializer registered under the same media type', async () => {
    const app = createWebApplication()
      .errorHandling(e => e.serializer('Text/Markdown', (_ctx, problem) => `# ${problem.code}`))
      .mount(orders())
    await app.bootstrap()

    const res = await app.request('/orders/42', { headers: { accept: 'text/markdown' } })

    expect(res.headers.get('content-type')).toBe('Text/Markdown; charset=utf-8')
    expect(await res.text()).toBe('# ERR_HTTP_CONFLICT')

    await app.close()
  })

  // An error page that fails must not turn one error into a hung request or a second, opaque one.
  it('falls back to JSON and logs the failure when a serializer throws', async () => {
    const logged: string[] = []
    const app = createWebApplication()
      .server(() => ({
        factory: { logger: { level: 'error', stream: { write: (line: string) => logged.push(line) } } },
      }))
      .errorHandling(e =>
        e.serializer('text/html', () => {
          throw new Error('template missing')
        }),
      )
      .mount(orders())
    await app.bootstrap()

    const res = await app.request('/orders/42', { headers: { accept: 'text/html' } })

    expect(res.status).toBe(409)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toMatchObject({ status: 409, code: 'ERR_HTTP_CONFLICT' })
    expect(logged.some(line => line.includes('Cannot serialize a problem as \\"text/html\\"'))).toBe(true)

    await app.close()
  })

  // A wildcard or a bare word would be offered to every client, or to none.
  it.each(['text/*', '*/*', 'html', ''])('refuses "%s" at start-up', async mediaType => {
    const app = createWebApplication().errorHandling(e => e.serializer(mediaType, () => ''))

    const failure = await app.bootstrap().then(
      () => undefined,
      (err: unknown) => err,
    )

    expect(failure).toBeInstanceOf(ErrConfiguration)
    expect((failure as Error).message.split('\n')[0]).toBe(
      `Cannot serialize problems as "${mediaType}": it is not a media type`,
    )
  })
})

describe('correlationID', () => {
  function payments() {
    return newRouter('/payments')
      .post('/', () => {
        throw new ErrHTTPConflict('Payment already captured')
      })
      .get('/helper', ctx => {
        ctx.badRequest()
      })
  }

  // The ID a support request quotes is the one the server's log lines carry for that request.
  it('is the request ID by default', async () => {
    const app = createWebApplication()
      .server(() => ({ factory: { requestIdHeader: 'x-request-id' } }))
      .mount(payments())
    await app.bootstrap()

    const thrown = await app.request('/payments', { method: 'POST', headers: { 'x-request-id': 'abc-123' } })
    expect(await thrown.json()).toMatchObject({ correlation_id: 'abc-123' })

    const helper = await app.request('/payments/helper', { headers: { 'x-request-id': 'def-456' } })
    expect(await helper.json()).toMatchObject({ correlation_id: 'def-456' })

    await app.close()
  })

  // A trace ID ties the error to every span of the request, across services.
  it('comes from the provider the application sets, such as the trace in traceparent', async () => {
    const app = createWebApplication()
      .errorHandling(e => e.correlationID(ctx => ctx.req.header('traceparent')?.split('-')[1]))
      .mount(payments())
    await app.bootstrap()

    const res = await app.request('/payments', {
      method: 'POST',
      headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
    })

    expect(await res.json()).toMatchObject({ correlation_id: '4bf92f3577b34da6a3ce929d0e0e4736' })

    await app.close()
  })

  // No ID is better than an empty one a client would quote back.
  it.each([
    ['no value', () => undefined],
    ['an empty one', () => ''],
  ])('is absent when the provider returns %s', async (_label, provider) => {
    const app = createWebApplication()
      .errorHandling(e => e.correlationID(provider))
      .mount(payments())
    await app.bootstrap()

    const problem = (await (await app.request('/payments', { method: 'POST' })).json()) as Record<string, unknown>

    expect(problem.code).toBe('ERR_HTTP_CONFLICT')
    expect(Object.keys(problem)).not.toContain('correlation_id')

    await app.close()
  })

  // The error is what the client needs; a provider failing on top of it must not cost them the answer.
  it('is absent, and the failure logged, when the provider throws', async () => {
    const logged: string[] = []
    const app = createWebApplication()
      .server(() => ({
        factory: { logger: { level: 'error', stream: { write: (line: string) => logged.push(line) } } },
      }))
      .errorHandling(e =>
        e.correlationID(() => {
          throw new Error('no active span')
        }),
      )
      .mount(payments())
    await app.bootstrap()

    const res = await app.request('/payments', { method: 'POST' })
    const problem = (await res.json()) as Record<string, unknown>

    expect(res.status).toBe(409)
    expect(Object.keys(problem)).not.toContain('correlation_id')
    expect(logged.some(line => line.includes('Cannot read the correlation ID'))).toBe(true)

    await app.close()
  })
})
