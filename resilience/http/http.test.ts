import { CaffeineIoC, Profile } from '@caffeinejs/di'
import { CatchWith, Controller, Get } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it } from 'vitest'

import { ErrBulkheadFull } from '../bulkhead/bulkhead.js'
import { ErrCallNotPermitted } from '../circuitbreaker/circuitbreaker.js'
import { ErrInvalidOption } from '../errors.js'
import { ErrRateLimitExceeded } from '../ratelimiter/ratelimiter.js'
import { ErrMaxRetriesExceeded } from '../retry/retry.js'
import { ErrTimeLimitExceeded } from '../timelimiter/timelimiter.js'
import { ResilienceErrorHandler } from './http.js'

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
