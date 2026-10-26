import { CaffeineIoC, Injectable, Profile, token } from '@caffeinejs/di'
import { Controller, Get } from '@caffeinejs/http'
import {
  CircuitBreaker,
  Fallback,
  Resilience,
  ResilienceRegistry,
  Retry,
  TimeLimiter,
} from '@caffeinejs/resilience/aop'
import { ResilienceErrorHandler, ResilienceHTTP } from '@caffeinejs/resilience/http'
import { Millisecond } from '@caffeinejs/std/duration'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startApp, type RunningApp } from './internal/app.js'
import { startUpstream, type Upstream } from './internal/upstream.js'

/**
 * A product page in front of an inventory service that blips, goes down, hangs and slows down, over real sockets.
 *
 * The page asks `CatalogClient`, whose `page()` carries a fallback, a retry, a circuit breaker and a time limiter.
 * `GET /live/:id` adds a whole-request budget on the controller and has no fallback, so its failures reach the
 * client. Every wait is on what is asserted: an answer, an arrival at the dependency, or a strategy's event.
 */

const kInventory = token<string>('inventory origin')

interface Stock {
  readonly id: string
  readonly count: number
  readonly stale: boolean
}

class InventoryUnavailable extends Error {
  constructor(readonly status: number) {
    super(`inventory answered ${status}`)
  }
}

@Injectable([kInventory])
@Profile('e2e-resilience-storefront')
class CatalogClient {
  constructor(private readonly origin: string) {}

  @Fallback('cachedPage')
  @Retry('inventory')
  @CircuitBreaker('inventory')
  @TimeLimiter('inventory')
  async page(id: string, signal?: AbortSignal): Promise<Stock> {
    return this.fetchStock(id, signal)
  }

  @Retry('inventory')
  @CircuitBreaker('inventory')
  @TimeLimiter('inventory')
  async live(id: string, signal?: AbortSignal): Promise<Stock> {
    return this.fetchStock(id, signal)
  }

  async cachedPage(_error: unknown, id: string): Promise<Stock> {
    return { id, count: 0, stale: true }
  }

  private async fetchStock(id: string, signal?: AbortSignal): Promise<Stock> {
    const res = await fetch(`${this.origin}/stock/${id}`, { signal })
    if (!res.ok) {
      throw new InventoryUnavailable(res.status)
    }
    const { count } = (await res.json()) as { count: number }
    return { id, count, stale: false }
  }
}

@Controller('/', [CatalogClient])
@Profile('e2e-resilience-storefront')
class StorefrontController {
  constructor(private readonly catalog: CatalogClient) {}

  @Get('/products/:id', p => [p.param('id'), p.signal()])
  async product(id: string, signal: AbortSignal): Promise<Stock> {
    return this.catalog.page(id, signal)
  }

  // The whole page gets 500 ms, whatever the retries inside it would take.
  @TimeLimiter('page')
  @Get('/live/:id', p => [p.param('id'), p.signal()])
  async live(id: string, signal: AbortSignal): Promise<Stock> {
    return this.catalog.live(id, signal)
  }
}
void StorefrontController

let upstream: Upstream
let running: RunningApp
let registry: ResilienceRegistry

beforeEach(async () => {
  upstream = await startUpstream({ status: 200, body: { count: 7 } })
  const container = new CaffeineIoC({ profiles: ['e2e-resilience-storefront'] })
  container.bind(kInventory, t => t.toValue(upstream.origin))
  running = await startApp(
    app =>
      app
        .install(
          Resilience(r =>
            r
              .retry('inventory', { maxAttempts: 3, backoff: 0 })
              .circuitBreaker('inventory', {
                minimumNumberOfCalls: 4,
                slidingWindow: { type: 'count', size: 4 },
                slowCallDurationThreshold: 200 * Millisecond,
                waitDurationInOpenState: 300 * Millisecond,
                automaticTransitionFromOpenToHalfOpen: true,
                permittedNumberOfCallsInHalfOpenState: 1,
              })
              .timeLimiter('inventory', { timeoutDuration: 300 * Millisecond })
              .timeLimiter('page', { timeoutDuration: 500 * Millisecond }),
          ),
        )
        .install(ResilienceHTTP())
        .errorHandling(e => e.globalHandlers(ResilienceErrorHandler)),
    { container },
  )
  registry = container.get(ResilienceRegistry)
})

afterEach(async () => {
  await running.close()
  await upstream.close()
})

const get = async (path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`${running.origin}${path}`, init)
  const text = await res.text()
  return { status: res.status, body: text === '' ? undefined : JSON.parse(text) }
}

describe('a product page in front of a flaky inventory service', { timeout: 30_000 }, () => {
  it('serves fresh stock with one call to the dependency when it is healthy', async () => {
    expect(await get('/products/42')).toEqual({ status: 200, body: { id: '42', count: 7, stale: false } })
    expect(upstream.arrivals).toHaveLength(1)
  })

  it('rides out a blip: two 503s and a 200 make one fresh page', async () => {
    upstream.script({ status: 503 }, { status: 503 })

    expect(await get('/products/42')).toEqual({ status: 200, body: { id: '42', count: 7, stale: false } })
    expect(upstream.arrivals).toHaveLength(3)
    expect(registry.retry('inventory').metrics().successfulCallsWithRetry).toBe(1)
  })

  // An open breaker is the point: while the dependency is down, pages come from the fallback and the dependency is
  // left alone to recover.
  it('serves stale pages without calling the dependency once the breaker opens on an outage', async () => {
    upstream.setDefault({ status: 503 })

    expect(await get('/products/1')).toEqual({ status: 200, body: { id: '1', count: 0, stale: true } })
    expect(await get('/products/2')).toEqual({ status: 200, body: { id: '2', count: 0, stale: true } })
    expect(registry.circuitBreaker('inventory').state).toBe('open')
    const calledWhileClosed = upstream.arrivals.length

    for (const id of ['3', '4', '5']) {
      expect(await get(`/products/${id}`)).toEqual({ status: 200, body: { id, count: 0, stale: true } })
    }
    expect(calledWhileClosed).toBe(4)
    expect(upstream.arrivals).toHaveLength(4)
  })

  it('serves fresh pages again once the dependency recovers and a trial call succeeds', async () => {
    upstream.setDefault({ status: 503 })
    await get('/products/1')
    await get('/products/2')
    const breaker = registry.circuitBreaker('inventory')
    expect(breaker.state).toBe('open')

    upstream.setDefault({ status: 200, body: { count: 9 } })
    await new Promise<void>(resolve => {
      const off = breaker.on('stateChange', event => {
        if (event.to === 'half_open') {
          off()
          resolve()
        }
      })
    })

    expect(await get('/products/3')).toEqual({ status: 200, body: { id: '3', count: 9, stale: false } })
    expect(breaker.state).toBe('closed')
  })

  // A dependency that accepts the request and never answers must not hold the page: each attempt is cut at its limit,
  // the request on the wire is abandoned, and the fallback answers after the last one.
  it('cuts each attempt at its limit when the dependency hangs, then answers from the fallback', async () => {
    upstream.script('hang', 'hang', 'hang')

    expect(await get('/products/42')).toEqual({ status: 200, body: { id: '42', count: 0, stale: true } })
    await upstream.abandoned(3)
    expect(upstream.arrivals).toHaveLength(3)
  })

  // The page's budget is the earlier deadline: it answers 504, aborts the attempt on the wire, and no attempt
  // starts after it.
  it('answers 504 when the page budget runs out first, and stops the retry with it', async () => {
    upstream.setDefault('hang')
    const ended = new Promise<number>(resolve => {
      const off = registry.retry('inventory').on('ignored', event => {
        off()
        resolve(event.attempts)
      })
    })

    const res = await get('/live/42')

    expect(res.status).toBe(504)
    expect(await ended).toBe(2)
    await upstream.abandoned(2)
    expect(upstream.arrivals).toHaveLength(2)
  })

  // Successful but slow calls are a degraded dependency: the breaker opens on the slow-call rate alone.
  it('opens the breaker on slow successful calls, then serves stale pages without calling', async () => {
    upstream.setDefault({ status: 200, body: { count: 7 }, delay: 250 })

    for (const id of ['1', '2', '3', '4']) {
      expect(await get(`/products/${id}`)).toEqual({ status: 200, body: { id, count: 7, stale: false } })
    }
    expect(registry.circuitBreaker('inventory').state).toBe('open')

    expect(await get('/products/5')).toEqual({ status: 200, body: { id: '5', count: 0, stale: true } })
    expect(upstream.arrivals).toHaveLength(4)
  })

  // A shopper who closes the tab should not keep the dependency busy: the request signal reaches the call on the wire.
  it('aborts the call to the dependency when the client disconnects, and runs no fallback', async () => {
    upstream.setDefault('hang')
    const stale = registry.fallbacks().find(policy => policy.name === 'CatalogClient.page')!
    const ignored = new Promise<string>(resolve => {
      const off = stale.on('ignored', event => {
        off()
        resolve(event.reason)
      })
    })
    const browser = new AbortController()

    const request = fetch(`${running.origin}/products/42`, { signal: browser.signal }).catch(() => undefined)
    await upstream.arrived(1)
    browser.abort()
    await request

    await upstream.abandoned(1)
    expect(await ignored).toBe('aborted')
    expect(upstream.arrivals).toHaveLength(1)
  })

  it('names no breaker or dependency in what a refused client reads', async () => {
    upstream.setDefault({ status: 503 })
    await get('/live/1')
    await get('/live/2')
    expect(registry.circuitBreaker('inventory').state).toBe('open')

    const res = await fetch(`${running.origin}/live/3`)
    const text = await res.text()

    expect(res.status).toBe(503)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(text).not.toContain('inventory')
    expect(JSON.parse(text)).toMatchObject({ code: 'ERR_CALL_NOT_PERMITTED' })
  })
})
