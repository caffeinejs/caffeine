import { CaffeineIoC, Injectable, Lifetime, Profile, Scopes, token } from '@caffeinejs/di'
import { Controller, Get } from '@caffeinejs/http'
import { Bulkhead, RateLimiter, Resilience, ResilienceRegistry } from '@caffeinejs/resilience/aop'
import { ResilienceErrorHandler, ResilienceHTTP } from '@caffeinejs/resilience/http'
import { instrumentBulkhead, instrumentRateLimiter } from '@caffeinejs/resilience/otel'
import { Hour, Millisecond, Second } from '@caffeinejs/std/duration'
import { PrometheusSerializer } from '@opentelemetry/exporter-prometheus'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startApp, type RunningApp } from './internal/app.js'
import { startUpstream, type Upstream } from './internal/upstream.js'

/**
 * A partner API with a quota and a capacity of its own, called through a request-scoped client, with the strategies'
 * metrics scraped over HTTP. The partner is a scripted server on a real socket that records every arrival and how
 * many requests it holds at once.
 */

const kPartner = token<string>('partner origin')
const kMetrics = token<PeriodicExportingMetricReader>('metrics reader')

class PartnerUnavailable extends Error {}

// A new instance per request: the quota and the bulkhead must still be one each, for every request.
@Lifetime(Scopes.REQUEST)
@Injectable([kPartner])
@Profile('e2e-resilience-partner')
class PartnerClient {
  constructor(private readonly origin: string) {}

  @RateLimiter('partner')
  async report(signal?: AbortSignal): Promise<string> {
    return this.call('/report', signal)
  }

  @RateLimiter('partner-strict')
  async strict(signal?: AbortSignal): Promise<string> {
    return this.call('/strict', signal)
  }

  @Bulkhead('exports')
  async export(signal?: AbortSignal): Promise<string> {
    return this.call('/export', signal)
  }

  @Bulkhead('solo')
  async solo(signal?: AbortSignal): Promise<string> {
    return this.call('/solo', signal)
  }

  private async call(path: string, signal?: AbortSignal): Promise<string> {
    const res = await fetch(`${this.origin}${path}`, { signal })
    if (!res.ok) {
      throw new PartnerUnavailable(`partner answered ${res.status}`)
    }
    return path
  }
}

@Lifetime(Scopes.REQUEST)
@Controller('/', [PartnerClient, kMetrics])
@Profile('e2e-resilience-partner')
class ReportsController {
  constructor(
    private readonly partner: PartnerClient,
    private readonly reader: PeriodicExportingMetricReader,
  ) {}

  @Get('/reports', p => [p.signal()])
  async report(signal: AbortSignal): Promise<string> {
    return this.partner.report(signal)
  }

  @Get('/strict', p => [p.signal()])
  async strict(signal: AbortSignal): Promise<string> {
    return this.partner.strict(signal)
  }

  @Get('/exports', p => [p.signal()])
  async export(signal: AbortSignal): Promise<string> {
    return this.partner.export(signal)
  }

  @Get('/solo', p => [p.signal()])
  async solo(signal: AbortSignal): Promise<string> {
    return this.partner.solo(signal)
  }

  @Get('/metrics')
  async metrics(): Promise<string> {
    return new PrometheusSerializer().serialize((await this.reader.collect()).resourceMetrics)
  }
}
void ReportsController

let partner: Upstream
let running: RunningApp
let registry: ResilienceRegistry
let meterProvider: MeterProvider

beforeEach(async () => {
  partner = await startUpstream({ status: 200, body: { ok: true } })
  const reader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    exportIntervalMillis: 3_600_000,
  })
  meterProvider = new MeterProvider({ readers: [reader] })
  const container = new CaffeineIoC({ profiles: ['e2e-resilience-partner'] })
  container.bind(kPartner, t => t.toValue(partner.origin))
  container.bind(kMetrics, t => t.toValue(reader))
  running = await startApp(
    app =>
      app
        .install(
          Resilience(r =>
            r
              .rateLimiter('partner', {
                limitForPeriod: 5,
                limitRefreshPeriod: 1 * Second,
                maxWaitDuration: 1_500 * Millisecond,
              })
              .rateLimiter('partner-strict', { limitForPeriod: 2, limitRefreshPeriod: 1 * Hour })
              .bulkhead('exports', { maxConcurrentCalls: 5, maxQueuedCalls: 10, maxWaitDuration: 10 * Second })
              .bulkhead('solo', { maxConcurrentCalls: 1, maxQueuedCalls: 5, maxWaitDuration: 10 * Second }),
          ),
        )
        .install(ResilienceHTTP())
        .errorHandling(e => e.globalHandlers(ResilienceErrorHandler)),
    { container },
  )
  registry = container.get(ResilienceRegistry)
  for (const quota of registry.rateLimiters()) {
    instrumentRateLimiter(quota, { meterProvider })
  }
  for (const pool of registry.bulkheads()) {
    instrumentBulkhead(pool, { meterProvider })
  }
})

afterEach(async () => {
  partner.releaseHung()
  await running.close()
  await partner.close()
  await meterProvider.shutdown()
})

const get = (path: string, init?: RequestInit) => fetch(`${running.origin}${path}`, init)

describe('a partner API with a quota and limited capacity', { timeout: 30_000 }, () => {
  // A burst that fits inside the wait is smoothed into the next period, never refused and never over the quota.
  it('lets a burst wait for the next period and serves every call, never more than the quota per period', async () => {
    const waited: number[] = []
    registry.rateLimiter('partner').on('permitted', event => waited.push(event.waited))

    const answers = await Promise.all(Array.from({ length: 8 }, () => get('/reports')))

    expect(answers.map(res => res.status)).toEqual(Array.from({ length: 8 }, () => 200))
    expect(partner.arrivals).toHaveLength(8)
    expect(waited.filter(ms => ms === 0)).toHaveLength(5)
    expect(waited.filter(ms => ms > 0 && ms <= 1_500)).toHaveLength(3)
  })

  // A spent quota is the partner's limit, not the client's fault: 503 with when to come back, naming nobody.
  it('answers 503 with Retry-After once the quota is spent, without reaching the partner', async () => {
    const answers = await Promise.all([get('/strict'), get('/strict'), get('/strict')])
    const refused = answers.find(res => res.status === 503)!
    const body = await refused.text()

    expect(answers.map(res => res.status).sort((a, b) => a - b)).toEqual([200, 200, 503])
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(body).not.toContain('partner')
    expect(partner.arrivals).toHaveLength(2)
  })

  // The bulkhead keeps a slow partner from holding every request this process serves.
  it('holds the partner to 5 calls at once, queues 10 and refuses the rest at once', async () => {
    partner.setDefault('hang')

    const calls = Array.from({ length: 50 }, () => get('/exports'))
    await partner.arrived(5)
    // Every request has reached the bulkhead once 10 wait and 35 were turned away.
    await expect
      .poll(() => registry.bulkhead('exports').metrics(), { timeout: 10_000 })
      .toMatchObject({ queuedCalls: 10, rejectedCalls: 35 })
    partner.setDefault({ status: 200, body: { ok: true } })
    partner.releaseHung()
    const answers = await Promise.all(calls)

    const statuses = answers.map(res => res.status)
    expect(statuses.filter(status => status === 503)).toHaveLength(35)
    expect(statuses.filter(status => status === 200)).toHaveLength(15)
    expect(answers.filter(res => res.status === 503).every(res => res.headers.get('retry-after') === null)).toBe(true)
    expect(partner.peakInFlight).toBe(5)
    expect(registry.bulkhead('exports').metrics().rejectedCalls).toBe(35)
  })

  // A client that left while queued must not cost the partner a call.
  it('takes a queued call out of line when its client disconnects, so it never reaches the partner', async () => {
    partner.setDefault('hang')
    const holding = get('/solo')
    await partner.arrived(1)
    const leaving = Array.from({ length: 2 }, () => new AbortController())
    const queued = leaving.map(controller => get('/solo', { signal: controller.signal }).catch(() => undefined))
    await expect.poll(() => registry.bulkhead('solo').metrics().queuedCalls, { timeout: 5_000 }).toBe(2)

    for (const controller of leaving) {
      controller.abort()
    }
    await Promise.all(queued)
    await expect.poll(() => registry.bulkhead('solo').metrics().queuedCalls, { timeout: 5_000 }).toBe(0)

    partner.setDefault({ status: 200, body: { ok: true } })
    partner.releaseHung()
    expect((await holding).status).toBe(200)
    expect((await get('/solo')).status).toBe(200)
    expect(partner.arrivals).toHaveLength(2)
  })

  it('reports the refusals in the metrics a scrape reads', async () => {
    await Promise.all([get('/strict'), get('/strict'), get('/strict')])

    const text = await (await get('/metrics')).text()

    expect(text).toMatch(
      /^resilience_rate_limiter_rejected_calls_total\{resilience_rate_limiter_name="partner-strict"[^}]*\} 1$/m,
    )
    expect(text).toMatch(/^resilience_bulkhead_rejected_calls_total\{resilience_bulkhead_name="exports"[^}]*\} 0$/m)
    expect(text).toMatch(
      /^resilience_rate_limiter_available_permissions\{resilience_rate_limiter_name="partner-strict"[^}]*\} 0$/m,
    )
  })
})
