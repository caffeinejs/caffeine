import { ErrFeatureNotInstalled, type Feature } from '@caffeinejs/application'
import { CaffeineIoC, Injectable, Profile } from '@caffeinejs/di'
import {
  BodyAsStream,
  Controller,
  Delete,
  ErrHTTPForbidden,
  ErrHTTPNotFound,
  Get,
  Keys,
  Method,
  Patch,
  Post,
  Prefix,
  Put,
} from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it } from 'vitest'

import { Bulkhead, CircuitBreaker, Fallback, RateLimiter, Resilient, Retry, TimeLimiter } from '../aop/annotations.js'
import { Resilience, type ResilienceBuilder } from '../aop/feature.js'
import { ResilienceRegistry } from '../aop/registry.js'
import { kEntrypoint } from '../aop/transport.js'
import { ErrInvalidOption } from '../errors.js'
import { ResilienceHTTP } from './feature.js'
import { ResilienceErrorHandler } from './http.js'

const opened: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const close of opened.splice(0)) {
    await close().catch(() => undefined)
  }
})

const instances = (r: ResilienceBuilder) =>
  r.preset('feed', p =>
    p
      .retry({ maxAttempts: 2, backoff: 0 })
      .circuitBreaker()
      .timeLimiter({ timeoutDuration: 1 * Second })
      .bulkhead()
      .rateLimiter({ limitForPeriod: 100, limitRefreshPeriod: 1 * Second }),
  )

// Boots a web application whose container sees the controllers of one profile only.
async function boot(profile: string, ...features: Feature[]) {
  let app = createWebApplication({ container: new CaffeineIoC({ profiles: [profile] }) })
  for (const feature of features) {
    app = app.install(feature)
  }
  opened.push(() => app.close())
  await app.bootstrap()
  return app
}

const refusal = (promise: Promise<unknown>) => promise.then(() => undefined).catch((error: unknown) => error as Error)

@Controller('/feed')
@Profile('rh-get')
class FeedController {
  attempts = 0

  @Retry('feed')
  @Get('/')
  async list(): Promise<string[]> {
    this.attempts++
    if (this.attempts === 1) {
      throw new Error('blip')
    }
    return ['a', 'b']
  }
}
void FeedController

describe('ResilienceHTTP() by default', () => {
  it('lets a GET handler carry @Retry, and retries it', async () => {
    const app = await boot('rh-get', Resilience(instances), ResilienceHTTP())

    const res = await app.request('/feed')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(['a', 'b'])
  })

  @Controller('/search')
  @Profile('rh-safe')
  class SearchController {
    attempts = 0

    // GET brings its HEAD twin: with these, the route answers every method RFC 9110 and the QUERY draft call safe.
    @Retry('feed')
    @Method(['get', 'options', 'trace', 'query'])
    @Get('/')
    async search(): Promise<string> {
      this.attempts++
      if (this.attempts === 1) {
        throw new Error('blip')
      }
      return 'found'
    }
  }
  void SearchController

  // A safe method changes nothing, so running its handler twice is what the CSRF check already assumes is harmless.
  it('lets a handler routed for every safe method carry @Retry, and retries a QUERY', async () => {
    const app = await boot('rh-safe', Resilience(instances), ResilienceHTTP())

    const res = await app.request('/search', {
      method: 'QUERY',
      headers: { 'content-type': 'application/json' },
      body: '{"q":"tea"}',
    })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('found')
  })

  @Controller('/orders')
  @Profile('rh-post')
  class OrdersController {
    @Retry('feed')
    @Post('/')
    async place(): Promise<string> {
      return 'placed'
    }
  }
  void OrdersController

  // A retried POST runs the handler, and every write in it, again: refused before the application serves anything.
  it('refuses a POST handler that carries @Retry, naming the route, the handler and the fixes', async () => {
    const error = await refusal(boot('rh-post', Resilience(instances), ResilienceHTTP()))

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect(error!.message).toContain(
      'Cannot retry "POST /orders" (OrdersController.place): POST is not a retryable method',
    )
    expect(error!.message).toContain("Move @Retry('feed') to the outbound client method the handler calls")
    expect(error!.message).toContain("Declare the handler repeatable with @Retry('feed', { repeatable: true })")
    expect(error!.message).toContain('Allow POST with ResilienceHTTP(h => h.retryableMethods(...))')
  })

  @Controller('/carts')
  @Profile('rh-post-preset')
  class CartsController {
    @Resilient('feed')
    @Post('/')
    async add(): Promise<string> {
      return 'added'
    }
  }
  void CartsController

  // A retry a preset brings replays the handler as surely as one written with @Retry.
  it('refuses a POST handler that a preset retries, naming @Resilient in the fixes', async () => {
    const error = await refusal(boot('rh-post-preset', Resilience(instances), ResilienceHTTP()))

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect(error!.message).toContain('Cannot retry "POST /carts" (CartsController.add): POST is not a retryable method')
    expect(error!.message).toContain("Move @Resilient('feed') to the outbound client method the handler calls")
    expect(error!.message).toContain("Declare the handler repeatable with @Resilient('feed', { repeatable: true })")
  })

  @Controller('/things')
  @Profile('rh-put')
  class PutController {
    @Retry('feed')
    @Put('/')
    async put(): Promise<string> {
      return 'ok'
    }
  }
  void PutController

  @Controller('/things')
  @Profile('rh-patch')
  class PatchController {
    @Retry('feed')
    @Patch('/')
    async patch(): Promise<string> {
      return 'ok'
    }
  }
  void PatchController

  @Controller('/things')
  @Profile('rh-delete')
  class DeleteController {
    @Retry('feed')
    @Delete('/')
    async remove(): Promise<string> {
      return 'ok'
    }
  }
  void DeleteController

  it.each([
    ['PUT', 'rh-put'],
    ['PATCH', 'rh-patch'],
    ['DELETE', 'rh-delete'],
  ])('refuses a %s handler that carries @Retry', async (method, profile) => {
    const error = await refusal(boot(profile, Resilience(instances), ResilienceHTTP()))

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect(error!.message).toContain(`${method} is not a retryable method`)
  })

  @Controller('/both')
  @Profile('rh-get-and-post')
  class BothController {
    @Retry('feed')
    @Get('/')
    @Method('post')
    async both(): Promise<string> {
      return 'ok'
    }
  }
  void BothController

  it('refuses a handler routed for GET and POST at once', async () => {
    const error = await refusal(boot('rh-get-and-post', Resilience(instances), ResilienceHTTP()))

    expect(error!.message).toContain('Cannot retry "POST /both" (BothController.both): POST is not a retryable method')
  })

  @Controller('/others')
  @Profile('rh-others')
  class OthersController {
    @Fallback('cached')
    @CircuitBreaker('feed')
    @TimeLimiter('feed')
    @Bulkhead('feed')
    @RateLimiter('feed')
    @Post('/')
    async create(): Promise<string> {
      return 'created'
    }

    async cached(_error: unknown): Promise<string> {
      return 'cached'
    }
  }
  void OthersController

  // None of them runs a handler twice.
  it('lets a POST handler carry every annotation but @Retry', async () => {
    const app = await boot('rh-others', Resilience(instances), ResilienceHTTP())

    const res = await app.request('/others', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('created')
  })

  @Injectable()
  @Profile('rh-service')
  class Notifier {
    attempts = 0

    @Retry('feed')
    async notify(): Promise<string> {
      this.attempts++
      if (this.attempts === 1) {
        throw new Error('blip')
      }
      return 'sent'
    }
  }

  @Controller('/notify', [Notifier])
  @Profile('rh-service')
  class NotifyController {
    constructor(private readonly notifier: Notifier) {}

    @Post('/')
    async send(): Promise<string> {
      return this.notifier.notify()
    }
  }
  void NotifyController

  // The repeated unit is one outbound call, which its author decided was safe to repeat.
  it('leaves a service’s @Retry alone, even when a POST handler calls it', async () => {
    const app = await boot('rh-service', Resilience(instances), ResilienceHTTP())

    const res = await app.request('/notify', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('sent')
  })
})

describe('ResilienceHTTP() on a class-level annotation', () => {
  @Resilient('feed')
  @Controller('/stock')
  @Profile('rh-class')
  class StockController {
    @Get('/')
    async list(): Promise<string> {
      return 'listed'
    }

    @Post('/')
    async add(): Promise<string> {
      return 'added'
    }
  }
  void StockController

  // A class-level retry reaches every handler, the unsafe ones included: each route is checked on its own.
  it('checks every route a class-level preset retries', async () => {
    const error = await refusal(boot('rh-class', Resilience(instances), ResilienceHTTP()))

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect(error!.message).toContain('Cannot retry "POST /stock" (StockController.add): POST is not a retryable method')
  })

  @Resilient('feed')
  @Controller('/stock')
  @Profile('rh-class-opt-out')
  class OptedOutController {
    @Get('/')
    async list(): Promise<string> {
      return 'listed'
    }

    @Retry(false)
    @Post('/')
    async add(): Promise<string> {
      return 'added'
    }
  }
  void OptedOutController

  it('boots once the unsafe route opts out of the retry', async () => {
    const app = await boot('rh-class-opt-out', Resilience(instances), ResilienceHTTP())

    expect((await app.request('/stock', { method: 'POST' })).status).toBe(200)
  })
})

describe('ResilienceHTTP() widened', () => {
  @Controller('/orders')
  @Profile('rh-repeatable')
  class RepeatableController {
    @Retry('feed', { repeatable: true })
    @Post('/')
    async place(): Promise<string> {
      return 'placed'
    }
  }
  void RepeatableController

  it('lets a POST handler that declares itself repeatable carry @Retry', async () => {
    const app = await boot('rh-repeatable', Resilience(instances), ResilienceHTTP())

    expect((await app.request('/orders', { method: 'POST' })).status).toBe(200)
  })

  @Controller('/carts')
  @Profile('rh-repeatable-preset')
  class RepeatableCartsController {
    @Resilient('feed', { repeatable: true })
    @Post('/')
    async add(): Promise<string> {
      return 'added'
    }
  }
  void RepeatableCartsController

  it('lets a POST handler that @Resilient declares repeatable run through the preset', async () => {
    const app = await boot('rh-repeatable-preset', Resilience(instances), ResilienceHTTP())

    expect((await app.request('/carts', { method: 'POST' })).status).toBe(200)
  })

  it('lets a PUT handler carry @Retry once PUT is retryable, and still refuses POST', async () => {
    await expect(
      boot(
        'rh-put',
        Resilience(instances),
        ResilienceHTTP(h => h.retryableMethods('GET', 'HEAD', 'OPTIONS', 'PUT')),
      ),
    ).resolves.toBeDefined()

    const error = await refusal(
      boot(
        'rh-post',
        Resilience(instances),
        ResilienceHTTP(h => h.retryableMethods('GET', 'HEAD', 'OPTIONS', 'PUT')),
      ),
    )
    expect(error!.message).toContain('POST is not a retryable method')
  })

  it('reads the methods from configuration, and lets code win', async () => {
    await expect(
      boot(
        'rh-put',
        Resilience(instances),
        ResilienceHTTP(h => h.config({ retryableMethods: ['get', 'put'] })),
      ),
    ).resolves.toBeDefined()

    const error = await refusal(
      boot(
        'rh-put',
        Resilience(instances),
        ResilienceHTTP(h => h.config({ retryableMethods: ['get', 'put'] }).retryableMethods('GET')),
      ),
    )
    expect(error!.message).toContain('PUT is not a retryable method')
  })

  @Controller('/uploads')
  @Profile('rh-stream')
  class UploadsController {
    @Retry('feed', { repeatable: true })
    @BodyAsStream()
    @Post('/')
    async upload(): Promise<string> {
      return 'stored'
    }
  }
  void UploadsController

  // The first attempt consumed the stream: a second would read nothing.
  it('refuses @Retry on a route that reads its body as a stream, even when repeatable', async () => {
    const error = await refusal(boot('rh-stream', Resilience(instances), ResilienceHTTP()))

    expect(error!.message).toContain(
      'Cannot retry "POST /uploads" (UploadsController.upload): the route reads its body as a stream, which cannot be read twice',
    )
  })
})

describe('ResilienceHTTP() and how a controller is bound', () => {
  @Controller('/subclassed')
  @Profile('rh-subclassed-base')
  class OrdersController {
    @Post('/')
    async place(): Promise<string> {
      return 'placed'
    }
  }

  class RetriedOrders extends OrdersController {
    @Retry('feed')
    override async place(): Promise<string> {
      return super.place()
    }
  }

  // The routes come from the key, the handler that runs from the class bound under it: a subclass that retries the
  // POST handler must not slip past the check.
  it('refuses a POST handler retried by the class a controller key is bound to', async () => {
    const container = new CaffeineIoC({ decorators: false })
    container.bind(OrdersController, t => t.toClass(RetriedOrders).labels(Keys.CONTROLLER, Keys.ENTRYPOINT))
    const app = createWebApplication({ container, logger: false })
      .install(Resilience(instances))
      .install(ResilienceHTTP())
    opened.push(() => app.close())

    const error = await refusal(app.bootstrap())

    expect(error?.message).toContain(
      'Cannot retry "POST /subclassed" (RetriedOrders.place): POST is not a retryable method',
    )
  })

  @Prefix('/api')
  @Controller('/prefixed')
  @Profile('rh-prefixed')
  class PrefixedController {
    @Retry('feed')
    @Post('/')
    async place(): Promise<string> {
      return 'placed'
    }
  }
  void PrefixedController

  // The first line names the route a reader can search for: the one the server answers on.
  it('names the route with its prefix', async () => {
    const error = await refusal(boot('rh-prefixed', Resilience(instances), ResilienceHTTP()))

    expect(error?.message).toContain('Cannot retry "POST /api/prefixed" (PrefixedController.place)')
  })
})

describe('the two halves', () => {
  it('refuses @Retry on a controller when ResilienceHTTP() is not installed', async () => {
    const error = await refusal(boot('rh-get', Resilience(instances)))

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect(error!.message).toContain(
      'Cannot retry "FeedController.list": @Retry(\'feed\') retries a request entrypoint that no installed transport integration checks',
    )
    expect(error!.message).toContain('ResilienceHTTP() from @caffeinejs/resilience/http for a controller')
  })

  it('refuses ResilienceHTTP() without Resilience()', async () => {
    const error = await refusal(boot('rh-get', ResilienceHTTP()))

    expect(error).toBeInstanceOf(ErrFeatureNotInstalled)
  })

  @Controller('/plain')
  @Profile('rh-plain')
  class PlainController {
    @CircuitBreaker('feed')
    @Get('/')
    async get(): Promise<string> {
      return 'ok'
    }
  }
  void PlainController

  it('needs no ResilienceHTTP() when no controller carries @Retry', async () => {
    const app = await boot('rh-plain', Resilience(instances))

    expect((await app.request('/plain')).status).toBe(200)
  })

  // `aop/` recognises an entrypoint by this registered symbol, without importing the HTTP package: if the HTTP package
  // renamed its label, controllers would silently escape the check.
  it('reads the entrypoint label the HTTP package writes', () => {
    expect(Keys.ENTRYPOINT).toBe(kEntrypoint)
  })
})

describe('ResilienceHTTP() and client errors', () => {
  @Controller('/items')
  @Profile('rh-client-errors')
  class ItemsController {
    runs = 0

    @Retry('items')
    @CircuitBreaker('items')
    @Get('/:id', p => [p.param('id')])
    async item(id: string): Promise<{ id: string }> {
      this.runs++
      switch (id) {
        case 'tea':
          return { id }
        case 'down':
          throw new Error('database down')
        case 'throttled':
          throw Object.assign(new Error('the dependency throttled'), { statusCode: 429 })
        case 'slow':
          throw Object.assign(new Error('the dependency timed out'), { statusCode: 408 })
        default:
          throw new ErrHTTPNotFound()
      }
    }
  }
  void ItemsController

  const orders = new Map([['o-1', { id: 'o-1', owner: 'alice', total: 42 }]])

  @Controller('/orders')
  @Profile('rh-client-errors')
  class OrdersController {
    answered = 0

    @Fallback('cached')
    @Get('/:id', p => [p.param('id'), p.header('x-user')])
    async order(id: string, user: string): Promise<unknown> {
      if (id === 'broken') {
        throw new Error('database down')
      }
      const order = orders.get(id)
      if (order?.owner !== user) {
        throw new ErrHTTPForbidden()
      }
      return order
    }

    async cached(_error: unknown, id: string): Promise<unknown> {
      this.answered++
      return orders.get(id) ?? { id, cached: true }
    }
  }
  void OrdersController

  // The defaults a preset gets when nobody thought of client errors: retry every error, count every error.
  async function serve() {
    const app = createWebApplication({ container: new CaffeineIoC({ profiles: ['rh-client-errors'] }) })
      .errorHandling(e => e.globalHandlers(ResilienceErrorHandler))
      .install(Resilience(r => r.preset('items', p => p.retry({ backoff: 0 }).circuitBreaker())))
      .install(ResilienceHTTP())
    opened.push(() => app.close())
    await app.bootstrap()
    return app
  }

  // One unauthenticated client asking for records that do not exist must not open the breaker for every client, nor
  // run the handler once per attempt.
  it('keeps a burst of 404s out of the retry and the breaker of a handler', async () => {
    const app = await serve()
    const controller = app.container.get(ItemsController)
    const breaker = app.container.get(ResilienceRegistry).circuitBreaker('items')

    const statuses = new Set<number>()
    for (let i = 0; i < 100; i++) {
      statuses.add((await app.request(`/items/missing-${i}`)).status)
    }

    expect([...statuses]).toEqual([404])
    expect(controller.runs).toBe(100)
    expect(breaker.state).toBe('closed')
    expect(breaker.metrics().bufferedCalls).toBe(0)
    expect((await app.request('/items/tea')).status).toBe(200)
  })

  it('still retries and counts a server error on the same handler', async () => {
    const app = await serve()
    const controller = app.container.get(ItemsController)
    const breaker = app.container.get(ResilienceRegistry).circuitBreaker('items')

    expect((await app.request('/items/down')).status).toBe(500)
    expect(controller.runs).toBe(3)
    expect(breaker.metrics()).toMatchObject({ bufferedCalls: 3, failedCalls: 3 })
  })

  // A dependency that throttled or timed out is failing for now, even when its error carries a 4xx status.
  it.each([
    ['429', 'throttled'],
    ['408', 'slow'],
  ])('still retries and counts a dependency error carrying %s', async (_status, id) => {
    const app = await serve()
    const controller = app.container.get(ItemsController)
    const breaker = app.container.get(ResilienceRegistry).circuitBreaker('items')

    await app.request(`/items/${id}`)

    expect(controller.runs).toBe(3)
    expect(breaker.metrics()).toMatchObject({ bufferedCalls: 3, failedCalls: 3 })
  })

  // A fallback serving cached orders would hand the refused caller the order it was refused.
  it('answers a 403 the handler throws with 403, never with the fallback', async () => {
    const app = await serve()
    const controller = app.container.get(OrdersController)

    const refused = await app.request('/orders/o-1', { headers: { 'x-user': 'mallory' } })

    expect(refused.status).toBe(403)
    expect(await refused.text()).not.toContain('alice')
    expect(controller.answered).toBe(0)
  })

  it('still answers a server error with the fallback', async () => {
    const app = await serve()
    const controller = app.container.get(OrdersController)

    const answered = await app.request('/orders/broken', { headers: { 'x-user': 'alice' } })

    expect(answered.status).toBe(200)
    expect(await answered.json()).toEqual({ id: 'broken', cached: true })
    expect(controller.answered).toBe(1)
  })
})
