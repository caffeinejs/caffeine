import { CaffeineIoC } from '@caffeinejs/di'
import { createApplication } from '@caffeinejs/std'
import {
  context,
  diag,
  DiagLogLevel,
  SpanStatusCode,
  trace,
  type Attributes,
  type DiagLogger,
} from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { Backend } from '../../backend.js'
import { FaultyBackend } from '../../backend.testkit.js'
import { MemoryLockBackend } from '../../backend/memory/index.js'
import type { DistLock } from '../../distlock.js'
import { kDistLock } from '../../keys.js'
import { distlock } from '../../plugin.js'
import { instrumentDistLock, type DistLockInstrumentationOptions } from './otel.js'

const contextManager = new AsyncLocalStorageContextManager()

beforeAll(() => {
  contextManager.enable()
  context.setGlobalContextManager(contextManager)
})

afterAll(() => {
  context.disable()
})

const cleanups: Array<() => Promise<unknown> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
})

async function newLock(backend: Backend = new MemoryLockBackend()): Promise<DistLock> {
  const app = createApplication({ container: new CaffeineIoC({ decorators: false }), logger: false }).with(
    distlock(d => d.backend(backend)),
  )

  await app.ready()
  cleanups.push(() => app.close())

  return app.container.get(kDistLock)
}

function instrument(options: Omit<DistLockInstrumentationOptions, 'tracerProvider' | 'meterProvider'> = {}) {
  const exporter = new InMemorySpanExporter()
  const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  const reader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    exportIntervalMillis: 3_600_000,
  })
  const meterProvider = new MeterProvider({ readers: [reader] })

  const stop = instrumentDistLock({ tracerProvider, meterProvider, ...options })
  cleanups.push(
    () => tracerProvider.shutdown(),
    () => meterProvider.shutdown(),
    stop,
  )

  return {
    stop,
    tracer: tracerProvider.getTracer('test'),
    spans: () => exporter.getFinishedSpans(),
    /** Every data point of the named metric, as its attributes plus its value. */
    points: async (name: string) => {
      const { resourceMetrics } = await reader.collect()
      return resourceMetrics.scopeMetrics
        .flatMap(scope => scope.metrics)
        .filter(metric => metric.descriptor.name === name)
        .flatMap(metric => metric.dataPoints as Array<{ attributes: Attributes; value: unknown }>)
    },
    allAttributes: async () => {
      const { resourceMetrics } = await reader.collect()
      return resourceMetrics.scopeMetrics
        .flatMap(scope => scope.metrics)
        .flatMap(metric => (metric.dataPoints as Array<{ attributes: Attributes }>).map(point => point.attributes))
    },
  }
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time')
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('instrumentDistLock spans', () => {
  // A lock span is only useful in the trace of the request that took the lock, and the acquisition and release
  // belong under the call that made them, not next to it.
  it('records the withLock span under the caller, with its acquire and release nested inside', async () => {
    const otel = instrument()
    const lock = await newLock()
    const request = otel.tracer.startSpan('request')

    await context.with(trace.setSpan(context.active(), request), () => lock.withLock('orders:1', () => 'done'))
    request.end()

    const spans = otel.spans().filter(span => span.name.startsWith('distlock.'))
    expect(spans.map(span => span.name).sort()).toEqual(['distlock.acquire', 'distlock.release', 'distlock.withLock'])

    for (const span of spans) {
      expect(span.attributes['distlock.key']).toBe('orders:1')
    }

    const withLock = spans.find(span => span.name === 'distlock.withLock')!
    const acquire = spans.find(span => span.name === 'distlock.acquire')!
    const release = spans.find(span => span.name === 'distlock.release')!
    expect(withLock.parentSpanContext?.spanId).toBe(request.spanContext().spanId)
    expect(acquire.parentSpanContext?.spanId).toBe(withLock.spanContext().spanId)
    expect(release.parentSpanContext?.spanId).toBe(withLock.spanContext().spanId)

    expect(acquire.attributes).toMatchObject({ 'distlock.outcome': 'acquired', 'distlock.mode': 'wait' })
    expect(release.attributes['distlock.lease_id']).toBe(acquire.attributes['distlock.lease_id'])
    expect(release.attributes['distlock.lapsed']).toBe(false)
  })

  it('nests the acquisition a once call made under the once span', async () => {
    const otel = instrument()
    const lock = await newLock()

    await lock.once('job', () => 'ran')

    const once = otel.spans().find(span => span.name === 'distlock.once')!
    const acquire = otel.spans().find(span => span.name === 'distlock.acquire')!
    expect(once.parentSpanContext).toBeUndefined()
    expect(acquire.parentSpanContext?.spanId).toBe(once.spanContext().spanId)
    expect(acquire.attributes['distlock.mode']).toBe('once')
  })

  // A timeout is a failure somebody should see; an abort is the caller changing its mind and must not light up
  // an error dashboard.
  it('marks a timed-out acquisition as an error, and an aborted one as not', async () => {
    const otel = instrument()
    const lock = await newLock()
    await lock.acquire('a', { ttl: '1m' })

    await lock.acquire('a', { wait: 10, retryDelay: 5 }).catch(() => undefined)
    await lock.acquire('a', { signal: AbortSignal.abort() }).catch(() => undefined)

    const [, timedOut, aborted] = otel.spans().filter(span => span.name === 'distlock.acquire')
    expect(timedOut!.status.code).toBe(SpanStatusCode.ERROR)
    expect(timedOut!.events.some(event => event.name === 'exception')).toBe(true)
    expect(aborted!.attributes['distlock.outcome']).toBe('aborted')
    expect(aborted!.status.code).toBe(SpanStatusCode.UNSET)
  })

  // A renewal fires long after the call that took the lock may have returned; hanging it under that call's span
  // would stretch a finished request across the whole lease.
  it('records a background renewal as a root span linked to the span that took the lock', async () => {
    const otel = instrument()
    const lock = await newLock()
    const request = otel.tracer.startSpan('request')

    await context.with(trace.setSpan(context.active(), request), () => lock.acquire('a', { ttl: 60, renew: true }))
    request.end()
    await until(() => otel.spans().some(span => span.name === 'distlock.extend'))

    const renewal = otel.spans().find(span => span.name === 'distlock.extend')!
    expect(renewal.parentSpanContext).toBeUndefined()
    expect(renewal.links.map(link => link.context.spanId)).toEqual([request.spanContext().spanId])
    expect(renewal.attributes).toMatchObject({ 'distlock.renewal': true, 'distlock.outcome': 'extended' })
  })

  it('marks a lost lease as an error', async () => {
    const otel = instrument()
    const backend = new FaultyBackend()
    const lock = await newLock(backend)

    const held = await lock.acquire('a', { ttl: '1m' })
    backend.stolen = true
    await held.extend()

    const extend = otel.spans().find(span => span.name === 'distlock.extend')!
    expect(extend.status).toMatchObject({ code: SpanStatusCode.ERROR, message: 'lost' })
  })
})

describe('instrumentDistLock metrics', () => {
  // The key is chosen per call and may be unbounded (`order:123`): as a metric attribute it would explode the
  // series count. The label is the bounded dimension a use case is split on instead.
  it('keeps the key out of every metric, and splits them by keyLabel', async () => {
    const otel = instrument({ keyLabel: key => key.split(':')[0] })
    const lock = await newLock()

    const held = await lock.acquire('orders:1', { ttl: '1m' })
    await lock.tryAcquire('orders:1')
    await held.release()
    await lock.once('jobs:nightly', () => 'ran')

    for (const attributes of await otel.allAttributes()) {
      expect(attributes).not.toHaveProperty('distlock.key')
    }

    const acquisitions = (await otel.points('distlock.acquire.duration')).map(point => point.attributes)
    expect(acquisitions).toHaveLength(3)
    expect(acquisitions).toEqual(
      expect.arrayContaining([
        { 'distlock.outcome': 'acquired', 'distlock.mode': 'wait', 'distlock.key.label': 'orders' },
        { 'distlock.outcome': 'held', 'distlock.mode': 'try', 'distlock.key.label': 'orders' },
        { 'distlock.outcome': 'acquired', 'distlock.mode': 'once', 'distlock.key.label': 'jobs' },
      ]),
    )

    expect(await otel.points('distlock.contended')).toEqual([
      expect.objectContaining({ attributes: { 'distlock.key.label': 'orders' }, value: 1 }),
    ])
    expect(await otel.points('distlock.hold.duration')).toEqual([
      expect.objectContaining({ attributes: { 'distlock.lapsed': false, 'distlock.key.label': 'orders' } }),
    ])
    expect(await otel.points('distlock.once')).toEqual([
      expect.objectContaining({
        attributes: { 'distlock.outcome': 'executed', 'distlock.lapsed': false, 'distlock.key.label': 'jobs' },
        value: 1,
      }),
    ])
  })

  it('counts lost leases and backend failures', async () => {
    const otel = instrument()
    const backend = new FaultyBackend()
    const lock = await newLock(backend)

    const held = await lock.acquire('a', { ttl: 60, renew: true })
    backend.failExtend = true
    await until(() => held.lost)

    expect(await otel.points('distlock.lease.lost')).toEqual([
      expect.objectContaining({ attributes: { 'distlock.reason': 'error', 'distlock.renewal': true }, value: 1 }),
    ])
    expect(await otel.points('distlock.backend.errors')).toEqual([
      expect.objectContaining({ attributes: { 'distlock.operation': 'extend' }, value: 1 }),
    ])
  })
})

describe('instrumentDistLock scope', () => {
  it('instruments only the given lock service', async () => {
    const first = await newLock()
    const second = await newLock()
    const otel = instrument({ service: first })

    await first.tryAcquire('first')
    await second.tryAcquire('second')

    expect(otel.spans().map(span => span.attributes['distlock.key'])).toEqual(['first'])
  })

  it('records no spans with tracing off, and no metrics with metrics off', async () => {
    const lock = await newLock()
    const spansOnly = instrument({ metrics: false })
    const metricsOnly = instrument({ tracing: false })

    await lock.withLock('a', () => 'done')

    expect(spansOnly.spans().map(span => span.name)).toContain('distlock.withLock')
    expect(await spansOnly.allAttributes()).toEqual([])
    expect(metricsOnly.spans()).toEqual([])
    expect(await metricsOnly.points('distlock.hold.duration')).toHaveLength(1)
  })

  it('records nothing once stopped', async () => {
    const lock = await newLock()
    const otel = instrument()

    otel.stop()
    await lock.withLock('a', () => 'done')

    expect(otel.spans()).toEqual([])
    expect(await otel.allAttributes()).toEqual([])
  })

  // A broken instrumentation must not take the lock, or the process, down with it.
  it('reports a failing handler to diag and keeps the lock working', async () => {
    const errors: unknown[][] = []
    const logger = { error: (...args: unknown[]) => errors.push(args) } as unknown as DiagLogger
    diag.setLogger(logger, DiagLogLevel.ERROR)
    cleanups.push(() => diag.disable())

    instrument({
      keyLabel: () => {
        throw new Error('label broke')
      },
    })
    const lock = await newLock()

    await expect(lock.withLock('a', () => 'done')).resolves.toBe('done')
    expect(await lock.tryAcquire('a')).toBeDefined()
    expect(errors.length).toBeGreaterThan(0)
    expect(String(errors[0]![0])).toContain('Cannot record distlock telemetry')
  })
})
