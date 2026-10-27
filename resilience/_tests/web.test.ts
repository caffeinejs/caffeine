import { CaffeineIoC, Injectable, Lifetime, Profile, Scopes } from '@caffeinejs/di'
import { Catch, Controller, Get, type IContext, Post } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { Hour, Millisecond, Minute, Second } from '@caffeinejs/std/duration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Bulkhead, CircuitBreaker, Fallback, RateLimiter, Retry, TimeLimiter } from '../aop/annotations.js'
import { Resilience } from '../aop/feature.js'
import { ResilienceRegistry } from '../aop/registry.js'
import { ErrCallRefused } from '../errors.js'
import { useFakeClock } from '../fake_clock.testkit.js'
import { ResilienceHTTP } from '../http/feature.js'
import { ResilienceErrorHandler } from '../http/http.js'
import { ErrTimeLimitExceeded } from '../timelimiter/timelimiter.js'

// What the fixtures record, reset before each test.
const seen = {
  catalogCalls: 0,
  catalogSignals: [] as AbortSignal[],
  pageSignals: [] as AbortSignal[],
  requestSignals: [] as AbortSignal[],
  feedHandlerCalls: 0,
  feedServiceCalls: 0,
  reportCalls: 0,
  scopedCalls: 0,
  orderAttempts: 0,
  orders: new Map<string, { id: string; item: string }>(),
  streamCalls: 0,
  streamSignals: [] as AbortSignal[],
  release: (() => undefined) as () => void,
  releaseStream: (() => undefined) as () => void,
}

let exportGate = Promise.resolve()
let streamGate = Promise.resolve()

beforeEach(() => {
  seen.catalogCalls = 0
  seen.catalogSignals = []
  seen.pageSignals = []
  seen.requestSignals = []
  seen.feedHandlerCalls = 0
  seen.feedServiceCalls = 0
  seen.reportCalls = 0
  seen.scopedCalls = 0
  seen.orderAttempts = 0
  seen.orders = new Map()
  seen.streamCalls = 0
  seen.streamSignals = []
  exportGate = new Promise<void>(resolve => (seen.release = resolve))
  streamGate = new Promise<void>(resolve => (seen.releaseStream = resolve))
})

@Injectable()
@Profile('resilience-web')
class Catalog {
  @Retry('inventory')
  @TimeLimiter('inventory')
  async stock(id: string, signal?: AbortSignal): Promise<{ id: string; count: number }> {
    seen.catalogCalls++
    seen.catalogSignals.push(signal!)
    if (id === 'hang') {
      return new Promise(() => undefined)
    }
    return { id, count: 1 }
  }

  async feed(): Promise<string[]> {
    seen.feedServiceCalls++
    return ['a', 'b']
  }

  @RateLimiter('lookup')
  async lookup(id: string): Promise<string> {
    return `found ${id}`
  }

  // Woven, but by a strategy that bounds no time.
  @CircuitBreaker('prices')
  async price(id: string, signal?: AbortSignal): Promise<string> {
    seen.catalogSignals.push(signal!)
    return `price ${id}`
  }
}

@Controller('/products', [Catalog])
@Profile('resilience-web')
class ProductsController {
  constructor(private readonly catalog: Catalog) {}

  // A whole-request budget, handed down to the service through the signal argument.
  @TimeLimiter('page')
  @Get('/:id', p => [p.param('id'), p.signal()])
  async show(id: string, signal: AbortSignal): Promise<unknown> {
    seen.pageSignals.push(signal)
    return this.catalog.stock(id, signal)
  }

  @Bulkhead('exports')
  @Get('/export/run')
  async export(): Promise<string> {
    await exportGate
    return 'exported'
  }

  @RateLimiter('search')
  @Get('/search/run')
  async search(): Promise<string> {
    return 'found'
  }

  @CircuitBreaker('reports')
  @Get('/reports/run')
  async report(): Promise<string> {
    seen.reportCalls++
    throw new Error('reporting database down')
  }

  @Fallback('degraded')
  @Get('/featured/:id', p => [p.param('id')])
  async featured(id: string): Promise<string> {
    throw new Error(`no featured ${id}`)
  }

  async degraded(_error: unknown, id: string): Promise<string> {
    return `degraded ${id}`
  }

  // A read the gate allows: the handler, and the service call inside it, run again on every attempt.
  @Retry('feed')
  @Get('/feed/run')
  async feed(): Promise<string[]> {
    seen.feedHandlerCalls++
    const items = await this.catalog.feed()
    if (seen.feedHandlerCalls === 1) {
      throw new Error('blip after reading')
    }
    return items
  }

  @Get('/lookup/:id', p => [p.param('id')])
  async lookup(id: string): Promise<string> {
    return this.catalog.lookup(id)
  }

  // The context is not a signal, so no weave replaces it: it carries the request's own signal.
  @CircuitBreaker('prices')
  @Get('/prices/:id', p => [p.param('id'), p.signal(), p.context()])
  async price(id: string, signal: AbortSignal, ctx: IContext): Promise<string> {
    seen.requestSignals.push(ctx.signal)
    seen.pageSignals.push(signal)
    return this.catalog.price(id, signal)
  }
}
void ProductsController

@Controller('/orders')
@Profile('resilience-web')
class OrdersController {
  // Repeatable because it upserts by the client's key: a second attempt finds the order the first one wrote.
  @Retry('orders', { repeatable: true })
  @Post('/', p => [p.header('idempotency-key'), p.body()])
  async place(key: string, body: { item: string }): Promise<{ id: string; item: string }> {
    seen.orderAttempts++
    let order = seen.orders.get(key)
    if (order === undefined) {
      order = { id: `order-${seen.orders.size + 1}`, item: body.item }
      seen.orders.set(key, order)
    }
    if (seen.orderAttempts === 1) {
      throw new Error('connection reset after the write')
    }
    return order
  }
}
void OrdersController

@Lifetime(Scopes.REQUEST)
@Controller('/scoped')
@Profile('resilience-web')
class ScopedController {
  @CircuitBreaker('scoped')
  @Get('/run')
  async run(): Promise<string> {
    seen.scopedCalls++
    throw new Error('down')
  }
}
void ScopedController

@Controller('/local')
@Profile('resilience-web')
class LocalController {
  @RateLimiter('local')
  @Get('/run')
  async run(): Promise<string> {
    return 'ok'
  }

  @Catch(ErrCallRefused)
  async refused(ctx: IContext): Promise<unknown> {
    ctx.status(429)
    return { local: true }
  }
}
void LocalController

const encoder = new TextEncoder()

@Controller('/streams')
@Profile('resilience-web')
class StreamsController {
  // The handler returns at once; its body is sent afterwards, and stops if the handler's signal aborts.
  @TimeLimiter('page')
  @Get('/slow', p => [p.signal()])
  async slow(signal: AbortSignal): Promise<Response> {
    seen.streamSignals.push(signal)
    const gate = streamGate
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('head'))
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
        },
        async pull(controller) {
          await gate
          if (!signal.aborted) {
            controller.enqueue(encoder.encode('tail'))
            controller.close()
          }
        },
      }),
    )
  }

  // The handler succeeds; the body it returned fails part-way, after the strategies have seen the outcome.
  @Retry('streamed')
  @CircuitBreaker('streamed')
  @Get('/broken')
  async broken(): Promise<Response> {
    seen.streamCalls++
    const gate = streamGate
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('head'))
        },
        async pull(controller) {
          await gate
          controller.error(new Error('disk gone'))
        },
      }),
    )
  }
}
void StreamsController

const opened: Array<() => Promise<unknown>> = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  seen.release()
  seen.releaseStream()
  for (const close of opened.splice(0)) {
    await close().catch(() => undefined)
  }
})

// A fresh application per test, so every breaker and quota starts closed and full.
async function storefront() {
  const app = createWebApplication({ container: new CaffeineIoC({ profiles: ['resilience-web'] }) })
    .install(
      Resilience(r =>
        r
          .timeLimiter('page', { timeoutDuration: 100 * Millisecond })
          .retry('inventory', { maxAttempts: 3, backoff: 0 })
          .timeLimiter('inventory', { timeoutDuration: 10 * Second })
          .bulkhead('exports', { maxConcurrentCalls: 1 })
          .rateLimiter('search', { limitForPeriod: 1, limitRefreshPeriod: 1 * Hour })
          .rateLimiter('lookup', { limitForPeriod: 1, limitRefreshPeriod: 1 * Hour })
          .rateLimiter('local', { limitForPeriod: 1, limitRefreshPeriod: 1 * Hour })
          .circuitBreaker('reports', {
            minimumNumberOfCalls: 2,
            slidingWindow: { type: 'count', size: 2 },
            waitDurationInOpenState: 1 * Minute,
          })
          .circuitBreaker('scoped', { minimumNumberOfCalls: 2, slidingWindow: { type: 'count', size: 2 } })
          .circuitBreaker('prices')
          .retry('feed', { maxAttempts: 2, backoff: 0 })
          .retry('orders', { maxAttempts: 2, backoff: 0 })
          .retry('streamed', { maxAttempts: 2, backoff: 0 })
          .circuitBreaker('streamed'),
      ),
    )
    .install(ResilienceHTTP())
    .errorHandling(e => e.globalHandlers(ResilienceErrorHandler))
  opened.push(() => app.close())
  await app.bootstrap()
  return app
}

describe('resilience on controllers', () => {
  it('answers 504 when a handler outruns its @TimeLimiter, its signal argument aborted at the limit', async () => {
    const app = await storefront()

    const res = await app.fetch('/products/hang')

    expect(res.status).toBe(504)
    expect(seen.pageSignals).toHaveLength(1)
    expect(seen.pageSignals[0]!.aborted).toBe(true)
    expect(seen.pageSignals[0]!.reason).toBeInstanceOf(ErrTimeLimitExceeded)
  })

  it('answers 503 without Retry-After past a handler’s @Bulkhead, while the admitted call completes', async () => {
    const app = await storefront()

    const admitted = app.fetch('/products/export/run')
    const refused = await app.fetch('/products/export/run')
    seen.release()

    expect(refused.status).toBe(503)
    expect(refused.headers.get('retry-after')).toBe(null)
    expect((await admitted).status).toBe(200)
  })

  it('answers 503 with Retry-After past a handler’s @RateLimiter', async () => {
    const app = await storefront()

    expect((await app.fetch('/products/search/run')).status).toBe(200)
    const refused = await app.fetch('/products/search/run')

    expect(refused.status).toBe(503)
    expect(refused.headers.get('retry-after')).toBe('3600')
  })

  it('answers 503 with Retry-After once a handler’s @CircuitBreaker opens, without running the handler', async () => {
    const app = await storefront()

    await app.fetch('/products/reports/run')
    await app.fetch('/products/reports/run')
    const refused = await app.fetch('/products/reports/run')

    expect(refused.status).toBe(503)
    expect(refused.headers.get('retry-after')).toBe('60')
    expect(seen.reportCalls).toBe(2)
  })

  it('answers with the @Fallback method, handed the same picked arguments', async () => {
    const app = await storefront()

    const res = await app.fetch('/products/featured/42')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('degraded 42')
  })

  // This is what the replay gate exists for: a retried handler runs everything in it again, service calls included.
  it('runs a retried GET handler, and the service call inside it, again', async () => {
    const app = await storefront()

    const res = await app.fetch('/products/feed/run')

    expect(res.status).toBe(200)
    expect(seen.feedHandlerCalls).toBe(2)
    expect(seen.feedServiceCalls).toBe(2)
  })

  it('leaves exactly one order when a repeatable POST keyed by Idempotency-Key fails after writing', async () => {
    const app = await storefront()

    const res = await app.fetch('/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-1' },
      body: JSON.stringify({ item: 'kettle' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'order-1', item: 'kettle' })
    expect(seen.orderAttempts).toBe(2)
    expect(seen.orders.size).toBe(1)
  })

  // A request-scoped controller is a new instance per request; its breaker is the container's, one for all.
  it('keeps the breaker of a request-scoped controller across requests', async () => {
    const app = await storefront()

    await app.fetch('/scoped/run')
    await app.fetch('/scoped/run')
    const refused = await app.fetch('/scoped/run')

    expect(refused.status).toBe(503)
    expect(seen.scopedCalls).toBe(2)
  })

  it('hands a refusal to the controller’s own @Catch before the global handler', async () => {
    const app = await storefront()

    await app.fetch('/local/run')
    const refused = await app.fetch('/local/run')

    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual({ local: true })
  })
})

describe('resilience on the services controllers call', () => {
  it('answers 503 when a service refuses a call made by a controller without annotations', async () => {
    const app = await storefront()

    expect(await (await app.fetch('/products/lookup/1')).text()).toBe('found 1')
    const refused = await app.fetch('/products/lookup/2')

    expect(refused.status).toBe(503)
    expect(refused.headers.get('retry-after')).toBe('3600')
  })

  // The page's budget is the earlier deadline: it must stop the service's call, and the retry must not start another.
  it('lets the controller’s budget abort the service’s call, before the service’s own limit or a retry', async () => {
    const app = await storefront()

    const res = await app.fetch('/products/hang')

    expect(res.status).toBe(504)
    expect(seen.catalogCalls).toBe(1)
    const attempt = seen.catalogSignals[0]!
    expect(attempt.aborted).toBe(true)
    expect((attempt.reason as ErrTimeLimitExceeded).timeLimiter).toBe('page')
  })

  // Nothing on this route bounds time, so the service must get the very signal the handler was handed: a disconnect
  // still reaches it, and no signal is made per call.
  it('passes the request signal through to the service when nothing derives one', async () => {
    const app = await storefront()

    const res = await app.fetch('/products/prices/42')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('price 42')
    expect(seen.requestSignals).toHaveLength(1)
    expect(seen.pageSignals).toHaveLength(1)
    expect(seen.catalogSignals).toHaveLength(1)
    expect(seen.pageSignals[0]).toBe(seen.requestSignals[0])
    expect(seen.catalogSignals[0]).toBe(seen.requestSignals[0])
  })
})

// A time limiter on a handler bounds the handler: once it returns a body to stream, the body is not timed.
describe('resilience on a handler that streams its response', () => {
  it('sends a body streamed past the handler’s time limit whole, and the limit never fires', async () => {
    const app = await storefront()
    const registry = app.container.get(ResilienceRegistry)
    useFakeClock({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })

    const res = await app.fetch('/streams/slow')
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    expect(decoder.decode((await reader.read()).value)).toBe('head')

    await vi.advanceTimersByTimeAsync(1 * Second)

    expect(seen.streamSignals).toHaveLength(1)
    expect(seen.streamSignals[0]!.aborted).toBe(false)
    expect(registry.timeLimiter('page').metrics()).toEqual({ successfulCalls: 1, failedCalls: 0, timedOutCalls: 0 })

    seen.releaseStream()
    expect(decoder.decode((await reader.read()).value)).toBe('tail')
    expect((await reader.read()).done).toBe(true)
  })

  // The handler already succeeded: a retry would answer a second time over a response under way.
  it('neither retries nor records a body that fails after the handler returned', async () => {
    const app = await storefront()
    const registry = app.container.get(ResilienceRegistry)

    const res = await app.fetch('/streams/broken')
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('head')
    seen.releaseStream()
    // The client sees the body cut short, as the transport reports it.
    await expect(reader.read()).rejects.toBeInstanceOf(Error)

    expect(seen.streamCalls).toBe(1)
    expect(registry.retry('streamed').metrics().successfulCallsWithoutRetry).toBe(1)
    expect(registry.circuitBreaker('streamed').metrics().successfulCalls).toBe(1)
    expect(registry.circuitBreaker('streamed').metrics().failedCalls).toBe(0)
  })
})
