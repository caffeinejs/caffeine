import { CaffeineIoC, Profile } from '@caffeinejs/di'
import { CatchWith, Controller, ErrHTTP, ErrHTTPBadRequest, ErrHTTPNotFound, Get } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it } from 'vitest'

import { CircuitBreaker, Retry } from '../aop/annotations.js'
import { Resilience } from '../aop/feature.js'
import { ResilienceRegistry } from '../aop/registry.js'
import { ErrBulkheadFull } from '../bulkhead/bulkhead.js'
import { ErrCallNotPermitted } from '../circuitbreaker/circuitbreaker.js'
import { ErrInvalidOption } from '../errors.js'
import { ErrRateLimitExceeded } from '../ratelimiter/ratelimiter.js'
import { ErrMaxRetriesExceeded } from '../retry/retry.js'
import { ErrTimeLimitExceeded } from '../timelimiter/timelimiter.js'
import { ResilienceHTTP } from './feature.js'
import { isClientError, ResilienceErrorHandler } from './http.js'

const opened: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const close of opened.splice(0)) {
    await close().catch(() => undefined)
  }
})

@Controller('/stock')
@Profile('resilience-http-handler')
class StockController {
  @Get('/open')
  async open(): Promise<never> {
    throw new ErrCallNotPermitted('inventory', 'open', 37 * Second)
  }

  @Get('/forced')
  async forced(): Promise<never> {
    throw new ErrCallNotPermitted('inventory', 'forced_open', undefined)
  }

  @Get('/quota/:ms', p => [p.param('ms')])
  async quota(ms: string): Promise<never> {
    throw new ErrRateLimitExceeded('partner-api', 100, 1 * Second, Number(ms) * Millisecond)
  }

  @Get('/full')
  async full(): Promise<never> {
    throw new ErrBulkheadFull('payments', 10, 0)
  }

  @Get('/slow')
  async slow(): Promise<never> {
    throw new ErrTimeLimitExceeded('inventory', 2 * Second)
  }

  @Get('/exhausted')
  async exhausted(): Promise<never> {
    throw new ErrMaxRetriesExceeded('inventory', 3, 'busy')
  }

  @Get('/misconfigured')
  async misconfigured(): Promise<never> {
    throw new ErrInvalidOption('Cannot create retry "inventory": maxAttempts must be an integer of at least 1, got 0')
  }

  @Get('/bug')
  async bug(): Promise<never> {
    throw new TypeError('undefined is not a function')
  }
}
void StockController

async function enrolled() {
  const app = createWebApplication({
    container: new CaffeineIoC({ profiles: ['resilience-http-handler'] }),
  }).errorHandling(e => e.globalHandlers(ResilienceErrorHandler))
  opened.push(() => app.close())
  await app.bootstrap()
  return app
}

describe('ResilienceErrorHandler', () => {
  // A refusal means the dependency is unavailable for now, not that the client did anything wrong.
  it('answers an open breaker with 503, the default envelope and Retry-After in seconds', async () => {
    const app = await enrolled()

    const res = await app.request('/stock/open')

    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('37')
    expect(await res.json()).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      code: 'ERR_CALL_NOT_PERMITTED',
      message: 'Service Unavailable',
    })
  })

  // The names of breakers and dependencies are internals: they must never reach a client.
  it('never names the breaker or the dependency in the body', async () => {
    const app = await enrolled()

    const text = await (await app.request('/stock/open')).text()

    expect(text).not.toContain('inventory')
    expect(text).not.toContain('Cannot call')
  })

  it('answers a forced-open breaker with 503 and no Retry-After, since nobody knows when it closes', async () => {
    const app = await enrolled()

    const res = await app.request('/stock/forced')

    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe(null)
  })

  // Retry-After counts whole seconds: a client told 0 would come straight back while the limit still holds.
  it.each([
    ['0', '1'],
    ['1', '1'],
    ['999', '1'],
    ['1000', '1'],
    ['1001', '2'],
  ])('rounds a rate limit’s %s ms wait up to Retry-After: %s', async (ms, header) => {
    const app = await enrolled()

    const res = await app.request(`/stock/quota/${ms}`)

    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe(header)
    expect(((await res.json()) as { code: string }).code).toBe('ERR_RATE_LIMIT_EXCEEDED')
  })

  it('answers a full bulkhead with 503 and no Retry-After', async () => {
    const app = await enrolled()

    const res = await app.request('/stock/full')

    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe(null)
    expect(((await res.json()) as { code: string }).code).toBe('ERR_BULKHEAD_FULL')
  })

  it('answers a time limit with 504 and no Retry-After', async () => {
    const app = await enrolled()

    const res = await app.request('/stock/slow')

    expect(res.status).toBe(504)
    expect(res.headers.get('retry-after')).toBe(null)
    expect(await res.json()).toEqual({
      statusCode: 504,
      error: 'Gateway Timeout',
      code: 'ERR_TIME_LIMIT_EXCEEDED',
      message: 'Gateway Timeout',
    })
  })

  // Neither is a refusal or a time limit: an exhausted retry and a bad option are left to the application's handlers.
  it.each(['/stock/exhausted', '/stock/misconfigured', '/stock/bug'])('leaves %s to the 500 default', async path => {
    const app = await enrolled()

    expect((await app.request(path)).status).toBe(500)
  })
})

@CatchWith(ResilienceErrorHandler)
@Controller('/scoped')
@Profile('resilience-http-scoped')
class ScopedController {
  @Get('/open')
  async open(): Promise<never> {
    throw new ErrCallNotPermitted('inventory', 'open', 2 * Second)
  }
}
void ScopedController

describe('ResilienceErrorHandler named with @CatchWith', () => {
  it('answers for the one controller that names it', async () => {
    const app = createWebApplication({ container: new CaffeineIoC({ profiles: ['resilience-http-scoped'] }) })
    opened.push(() => app.close())
    await app.bootstrap()

    const res = await app.request('/scoped/open')

    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('2')
  })
})

describe('isClientError', () => {
  // The application's own 4xx answers the client's mistake: another attempt or a breaker failure would blame a
  // dependency for it.
  it.each([
    ['an ErrHTTP 400', new ErrHTTPBadRequest()],
    ['an ErrHTTP 404', new ErrHTTPNotFound()],
    ['an ErrHTTP 408 the application answers', new ErrHTTP(408, 'Request Timeout')],
    ['an ErrHTTP 429 the application answers', new ErrHTTP(429, 'Too Many Requests')],
    ['an error carrying statusCode 404', Object.assign(new Error('missing'), { statusCode: 404 })],
    ['an error carrying status 422', Object.assign(new Error('invalid'), { status: 422 })],
  ])('is true for %s', (_, error) => {
    expect(isClientError(error)).toBe(true)
  })

  // A dependency that timed out or throttled is failing for now: retries and the breaker must still see it.
  it.each([
    ['an ErrHTTP 500', new ErrHTTP(500, 'Internal Server Error')],
    ['an ErrHTTP 503', new ErrHTTP(503, 'Service Unavailable')],
    ['an error carrying status 408 from a dependency', Object.assign(new Error('timeout'), { status: 408 })],
    ['an error carrying statusCode 429 from a dependency', Object.assign(new Error('throttled'), { statusCode: 429 })],
    ['an error carrying status 503', Object.assign(new Error('down'), { status: 503 })],
    ['an error carrying status "404" as text', Object.assign(new Error('missing'), { status: '404' })],
    ['an error with no status', new Error('down')],
    ['undefined', undefined],
    ['null', null],
    ['a bare 404', 404],
  ])('is false for %s', (_, error) => {
    expect(isClientError(error)).toBe(false)
  })
})

const catalog = { attempts: 0 }

@Controller('/catalog')
@Profile('resilience-http-client-errors')
class CatalogController {
  @Retry('catalog')
  @CircuitBreaker('catalog')
  @Get('/:id', p => [p.param('id')])
  async item(id: string): Promise<never> {
    catalog.attempts++
    throw id === 'missing' ? new ErrHTTPNotFound() : new Error('database down')
  }
}
void CatalogController

describe('isClientError on a controller', () => {
  // A burst of 404s is clients asking for what does not exist: it must not open the breaker for everyone.
  it('keeps 404s out of the retry and the breaker, while a server error is still retried', async () => {
    catalog.attempts = 0
    const app = createWebApplication({
      container: new CaffeineIoC({ profiles: ['resilience-http-client-errors'] }),
    })
      .install(
        Resilience(r =>
          r.preset('catalog', p =>
            p.retry({ maxAttempts: 3, backoff: 0, retryOn: error => !isClientError(error) }).circuitBreaker({
              slidingWindow: { type: 'count', size: 4 },
              minimumNumberOfCalls: 4,
              ignoreError: isClientError,
            }),
          ),
        ),
      )
      .install(ResilienceHTTP())
    opened.push(() => app.close())
    await app.bootstrap()

    for (let i = 0; i < 4; i++) {
      expect((await app.request('/catalog/missing')).status).toBe(404)
    }
    const breaker = app.container.get(ResilienceRegistry).circuitBreaker('catalog')

    expect(catalog.attempts).toBe(4)
    expect(breaker.state).toBe('closed')
    expect(breaker.metrics().bufferedCalls).toBe(0)

    expect((await app.request('/catalog/tea')).status).toBe(500)
    expect(catalog.attempts).toBe(7)
    expect(breaker.metrics().failedCalls).toBe(3)
  })
})
