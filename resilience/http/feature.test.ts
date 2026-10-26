import { ErrFeatureNotInstalled, type Feature } from '@caffeinejs/application'
import { CaffeineIoC, Injectable, Profile } from '@caffeinejs/di'
import { BodyAsStream, Controller, Delete, Get, Keys, Method, Patch, Post, Prefix, Put } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it } from 'vitest'

import { Bulkhead, CircuitBreaker, Fallback, RateLimiter, Retry, TimeLimiter } from '../aop/annotations.js'
import { Resilience, type ResilienceBuilder } from '../aop/feature.js'
import { ErrInvalidOption } from '../errors.js'
import { ResilienceHTTP } from './feature.js'

const opened: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const close of opened.splice(0)) {
    await close().catch(() => undefined)
  }
})

const instances = (r: ResilienceBuilder) =>
  r
    .retry('feed', { maxAttempts: 2, backoff: 0 })
    .circuitBreaker('feed')
    .timeLimiter('feed', { timeoutDuration: 1 * Second })
    .bulkhead('feed')
    .rateLimiter('feed', { limitForPeriod: 100, limitRefreshPeriod: 1 * Second })

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

    const res = await app.fetch('/feed')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(['a', 'b'])
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

    const res = await app.fetch('/others', { method: 'POST' })

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

    const res = await app.fetch('/notify', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('sent')
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

    expect((await app.fetch('/orders', { method: 'POST' })).status).toBe(200)
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
    container.bind(OrdersController, t => t.toClass(RetriedOrders).labels(Keys.CONTROLLER))
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
      'Cannot retry "FeedController.list": @Retry on a controller needs the HTTP replay check',
    )
    expect(error!.message).toContain('Install ResilienceHTTP() from @caffeinejs/resilience/http')
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

    expect((await app.fetch('/plain')).status).toBe(200)
  })

  // `aop/` recognises a controller by this registered symbol, without importing the HTTP package: if the HTTP package
  // renamed its label, controllers would silently escape the check.
  it('reads the controller label the HTTP package writes', () => {
    expect(Keys.CONTROLLER).toBe(Symbol.for('@caffeinejs/http:controller'))
  })
})
