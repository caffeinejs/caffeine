import { subscribe, unsubscribe } from 'node:diagnostics_channel'

import {
  context,
  diag,
  metrics,
  SpanStatusCode,
  trace,
  type Attributes,
  type MeterProvider,
  type Span,
  type TracerProvider,
} from '@opentelemetry/api'

import type { DistLock } from '../../distlock.js'
import {
  DIST_LOCK_CHANNELS,
  type AcquireContext,
  type ContendedMessage,
  type ExtendContext,
  type LockEventBase,
  type LostMessage,
  type OnceContext,
  type ReleaseContext,
  type WithLockContext,
} from '../channels.js'

const SCOPE = '@caffeinejs/distlock'

type TracedOperation = 'acquire' | 'withLock' | 'once' | 'extend' | 'release'

const operations: readonly TracedOperation[] = ['acquire', 'withLock', 'once', 'extend', 'release']

export interface DistLockInstrumentationOptions {
  /** Defaults to the global provider, `trace.getTracerProvider()`. */
  tracerProvider?: TracerProvider
  /** Defaults to the global provider, `metrics.getMeterProvider()`. */
  meterProvider?: MeterProvider
  /** Records spans. On by default. */
  tracing?: boolean
  /** Records metrics. On by default. */
  metrics?: boolean
  /**
   * Maps a lock key to a bounded label, recorded as `distlock.key.label` on spans and metrics — how metrics split
   * per use case, e.g. `key => key.split(':')[0]`.
   *
   * Metrics never carry the key itself: it is chosen per call and may be unbounded. Spans carry it as
   * `distlock.key`. Return `undefined` to leave a key unlabelled.
   */
  keyLabel?: (key: string) => string | undefined
  /** Instruments only this lock service. Every lock service in the process is instrumented when omitted. */
  service?: DistLock
}

/**
 * Records OpenTelemetry spans and metrics for the lock services in this process, from their
 * `node:diagnostics_channel` channels. Returns the function that stops it.
 *
 * It needs no reference to a lock service and no application, and can be called before or after one exists.
 * Calling it twice records everything twice.
 *
 * Spans: `distlock.acquire`, `distlock.withLock`, `distlock.once`, `distlock.extend` and `distlock.release`,
 * children of whatever span was active when the call was made. A background renewal is a root span linked to
 * that span instead, since it runs long after the call that took the lock may have ended. A timeout, a backend
 * failure, a lost lease and a critical section that outran its lease set the span status to `ERROR`; an aborted
 * acquisition does not.
 *
 * Metrics: `distlock.acquire.duration` and `distlock.acquire.attempts` (histograms, by outcome and mode),
 * `distlock.hold.duration` (histogram, by whether the lease lapsed), and the counters `distlock.contended`,
 * `distlock.lease.lost`, `distlock.backend.errors` and `distlock.once`.
 *
 * A handler that throws is reported to `diag.error` and never reaches the lock or the process.
 */
export function instrumentDistLock(options: DistLockInstrumentationOptions = {}): () => void {
  const subscriptions: Array<[channel: string, onMessage: (message: unknown, name: string | symbol) => void]> = []
  const labelOf = options.keyLabel

  function on<T extends LockEventBase>(channel: string, handler: (message: T) => void): void {
    const onMessage = (message: unknown, name: string | symbol): void => {
      const event = message as T
      if (options.service !== undefined && event.service !== options.service) {
        return
      }

      // Left to `node:diagnostics_channel`, a throw would come back as an uncaught exception.
      try {
        handler(event)
      } catch (error) {
        diag.error(`Cannot record distlock telemetry for "${String(name)}"`, error)
      }
    }

    subscribe(channel, onMessage)
    subscriptions.push([channel, onMessage])
  }

  function label(key: string): Attributes {
    const value = labelOf?.(key)
    return value === undefined ? {} : { 'distlock.key.label': value }
  }

  if (options.tracing !== false) {
    const tracer = (options.tracerProvider ?? trace.getTracerProvider()).getTracer(SCOPE)
    const spans = new WeakMap<object, Span>()

    for (const operation of operations) {
      const channel = DIST_LOCK_CHANNELS[operation]

      // `start` runs synchronously in the caller's async context, so the active span there is the parent —
      // unless the context names the `withLock` or `once` call it ran inside, whose span is the parent then.
      // A channel subscriber cannot make a span active for the traced call, so that link is how they nest.
      on<LockEventBase>(`tracing:${channel}:start`, ctx => {
        const attributes = { 'distlock.key': ctx.key, ...label(ctx.key), ...startAttributes(operation, ctx) }
        const name = `distlock.${operation}`

        if (operation === 'extend' && (ctx as ExtendContext).renewal) {
          const holder = trace.getSpan(context.active())
          const links = holder === undefined ? [] : [{ context: holder.spanContext() }]
          spans.set(ctx, tracer.startSpan(name, { root: true, links, attributes }))
          return
        }

        const outer = (ctx as AcquireContext | ReleaseContext).parent
        const outerSpan = outer === undefined ? undefined : spans.get(outer)
        const parent = outerSpan === undefined ? context.active() : trace.setSpan(context.active(), outerSpan)

        spans.set(ctx, tracer.startSpan(name, { attributes }, parent))
      })

      on<LockEventBase>(`tracing:${channel}:asyncEnd`, ctx => {
        const span = spans.get(ctx)
        if (span === undefined) {
          return
        }

        spans.delete(ctx)
        span.setAttributes(endAttributes(operation, ctx))

        const error = (ctx as { error?: unknown }).error
        if (error !== undefined) {
          span.recordException(error instanceof Error ? error : String(error))
        }

        const failure = failureOf(operation, ctx)
        if (failure !== undefined) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: failure })
        }

        span.end()
      })
    }
  }

  if (options.metrics !== false) {
    const meter = (options.meterProvider ?? metrics.getMeterProvider()).getMeter(SCOPE)

    const acquireDuration = meter.createHistogram('distlock.acquire.duration', {
      unit: 's',
      description: 'Time spent acquiring a lock, retries included',
    })
    const acquireAttempts = meter.createHistogram('distlock.acquire.attempts', {
      unit: '{attempt}',
      description: 'Attempts one acquisition made',
    })
    const holdDuration = meter.createHistogram('distlock.hold.duration', {
      unit: 's',
      description: 'Time a lease was held, from acquisition to release',
    })
    const contended = meter.createCounter('distlock.contended', {
      unit: '{attempt}',
      description: 'Attempts that found the key held by someone else',
    })
    const leaseLost = meter.createCounter('distlock.lease.lost', {
      unit: '{lease}',
      description: 'Leases this process believed it held and no longer did',
    })
    const backendErrors = meter.createCounter('distlock.backend.errors', {
      unit: '{error}',
      description: 'Backend calls that failed',
    })
    const onceCalls = meter.createCounter('distlock.once', { unit: '{call}', description: 'Calls to once, by outcome' })

    on<AcquireContext>(`tracing:${DIST_LOCK_CHANNELS.acquire}:asyncEnd`, ctx => {
      const attributes = { 'distlock.outcome': ctx.outcome ?? 'error', 'distlock.mode': ctx.mode, ...label(ctx.key) }

      acquireDuration.record((ctx.waitedMs ?? 0) / 1000, attributes)
      acquireAttempts.record(ctx.attempts ?? 0, attributes)

      if (ctx.outcome === 'error') {
        backendErrors.add(1, { 'distlock.operation': 'acquire', ...label(ctx.key) })
      }
    })

    on<ExtendContext>(`tracing:${DIST_LOCK_CHANNELS.extend}:asyncEnd`, ctx => {
      if (ctx.outcome === 'error') {
        backendErrors.add(1, { 'distlock.operation': 'extend', ...label(ctx.key) })
      }
    })

    on<ReleaseContext>(`tracing:${DIST_LOCK_CHANNELS.release}:asyncEnd`, ctx => {
      if (ctx.heldMs !== undefined) {
        holdDuration.record(ctx.heldMs / 1000, { 'distlock.lapsed': ctx.lapsed === true, ...label(ctx.key) })
      }

      if (ctx.error !== undefined) {
        backendErrors.add(1, { 'distlock.operation': 'release', ...label(ctx.key) })
      }
    })

    on<OnceContext>(`tracing:${DIST_LOCK_CHANNELS.once}:asyncEnd`, ctx => {
      onceCalls.add(1, {
        'distlock.outcome': ctx.outcome ?? 'failed',
        'distlock.lapsed': ctx.lapsed === true,
        ...label(ctx.key),
      })
    })

    on<ContendedMessage>(DIST_LOCK_CHANNELS.contended, message => {
      contended.add(1, label(message.key))
    })

    on<LostMessage>(DIST_LOCK_CHANNELS.lost, message => {
      leaseLost.add(1, {
        'distlock.reason': message.reason,
        'distlock.renewal': message.renewal,
        ...label(message.key),
      })
    })
  }

  return () => {
    for (const [channel, onMessage] of subscriptions.splice(0)) {
      unsubscribe(channel, onMessage)
    }
  }
}

function startAttributes(operation: TracedOperation, ctx: LockEventBase): Attributes {
  switch (operation) {
    case 'acquire':
      return { 'distlock.mode': (ctx as AcquireContext).mode }
    case 'extend':
      return { 'distlock.lease_id': (ctx as ExtendContext).leaseID, 'distlock.renewal': (ctx as ExtendContext).renewal }
    case 'release':
      return { 'distlock.lease_id': (ctx as ReleaseContext).leaseID }
    default:
      return {}
  }
}

function endAttributes(operation: TracedOperation, ctx: LockEventBase): Attributes {
  switch (operation) {
    case 'acquire': {
      const acquire = ctx as AcquireContext
      return defined({
        'distlock.outcome': acquire.outcome,
        'distlock.attempts': acquire.attempts,
        'distlock.lease_id': acquire.leaseID,
      })
    }
    case 'withLock': {
      const hold = ctx as WithLockContext
      return defined({ 'distlock.lease_id': hold.leaseID, 'distlock.lapsed': hold.lapsed })
    }
    case 'once': {
      const once = ctx as OnceContext
      return defined({
        'distlock.outcome': once.outcome,
        'distlock.lease_id': once.leaseID,
        'distlock.lapsed': once.lapsed,
      })
    }
    case 'extend':
      return defined({ 'distlock.outcome': (ctx as ExtendContext).outcome })
    case 'release':
      return defined({ 'distlock.lapsed': (ctx as ReleaseContext).lapsed })
  }
}

// Why the span failed, or `undefined` when it did not. An aborted acquisition is the caller changing its mind.
function failureOf(operation: TracedOperation, ctx: LockEventBase): string | undefined {
  switch (operation) {
    case 'acquire': {
      const outcome = (ctx as AcquireContext).outcome
      return outcome === 'timeout' || outcome === 'error' ? outcome : undefined
    }
    case 'extend': {
      const outcome = (ctx as ExtendContext).outcome
      return outcome === 'lost' || outcome === 'error' ? outcome : undefined
    }
    case 'once': {
      const once = ctx as OnceContext
      return once.outcome === 'failed' ? 'failed' : once.lapsed === true ? 'lapsed' : undefined
    }
    default: {
      const settled = ctx as WithLockContext & ReleaseContext
      return settled.error !== undefined ? 'error' : settled.lapsed === true ? 'lapsed' : undefined
    }
  }
}

function defined(attributes: Record<string, string | number | boolean | undefined>): Attributes {
  const result: Attributes = {}
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      result[name] = value
    }
  }

  return result
}
