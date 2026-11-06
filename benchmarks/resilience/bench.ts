import { compose, decorate } from '@caffeinejs/resilience'
import { bulkhead } from '@caffeinejs/resilience/bulkhead'
import { circuitBreaker } from '@caffeinejs/resilience/circuitbreaker'
import { fallback } from '@caffeinejs/resilience/fallback'
import { rateLimiter } from '@caffeinejs/resilience/ratelimiter'
import { retry } from '@caffeinejs/resilience/retry'
import { timeLimiter } from '@caffeinejs/resilience/timelimiter'
import { Hour, Second } from '@caffeinejs/std/duration'
import {
  circuitBreaker as cockatielBreaker,
  ConsecutiveBreaker,
  ConstantBackoff,
  handleAll,
  retry as cockatielRetry,
  wrap,
} from 'cockatiel'
import { bench, group, run, summary } from 'mitata'
import CircuitBreaker from 'opossum'

// The protected operation does no work, so every nanosecond measured is the policy's own overhead.
const op = async (): Promise<number> => 1
const ignore = (): void => undefined
// What a wrapped operation is called with when nobody passes a signal.
const ctx = { signal: undefined }

// A fresh instance per benchmark, so an open breaker in one never leaks into another.
const caffeineBreaker = () => circuitBreaker({ name: 'bench' })
const caffeineRetry = () => retry({ name: 'bench', backoff: 0 })
const cockatielBreakerPolicy = () =>
  cockatielBreaker(handleAll, { halfOpenAfter: 60_000, breaker: new ConsecutiveBreaker(1_000_000) })
const cockatielRetryPolicy = () => cockatielRetry(handleAll, { maxAttempts: 2, backoff: new ConstantBackoff(0) })

// opossum's defaults start a timeout timer per call; the other two have none, so it is turned off here.
const opossumBreakers: CircuitBreaker[] = []
const opossumBreaker = (): CircuitBreaker<[], number> => {
  const breaker = new CircuitBreaker(op, { timeout: false, errorThresholdPercentage: 50, resetTimeout: 60_000 })
  opossumBreakers.push(breaker)
  return breaker
}

group('breaker, success path', () => {
  summary(() => {
    const decorated = decorate(caffeineBreaker(), op)
    const wrapped = caffeineBreaker().wrap(op)
    const cockatiel = cockatielBreakerPolicy()
    const opossum = opossumBreaker()

    bench('success: raw call', async () => {
      await op()
    })
    bench('success: decorate(breaker, op)', async () => {
      await decorated()
    })
    bench('success: breaker.wrap(op)', async () => {
      await wrapped(ctx)
    })
    bench('success: cockatiel breaker', async () => {
      await cockatiel.execute(op)
    })
    bench('success: opossum breaker', async () => {
      await opossum.fire()
    })
  })
})

group('retry + breaker, success path', () => {
  summary(() => {
    const decorated = decorate(compose(caffeineRetry(), caffeineBreaker()), op)
    const composed = compose(caffeineRetry(), caffeineBreaker())(op)
    const cockatiel = wrap(cockatielRetryPolicy(), cockatielBreakerPolicy())

    bench('retry+breaker: decorate(compose(retries, breaker), op)', async () => {
      await decorated()
    })
    bench('retry+breaker: compose(retries, breaker)(op)', async () => {
      await composed(ctx)
    })
    bench('retry+breaker: cockatiel wrap(retry, breaker)', async () => {
      await cockatiel.execute(op)
    })
  })
})

group('breaker open, rejection path', () => {
  summary(() => {
    const caffeine = caffeineBreaker()
    caffeine.forceOpen()
    const decorated = decorate(caffeine, op)
    const stackCapturing = circuitBreaker({ name: 'bench', captureStackTrace: true })
    stackCapturing.forceOpen()
    const withStack = decorate(stackCapturing, op)
    const cockatiel = cockatielBreakerPolicy()
    cockatiel.isolate()
    const opossum = opossumBreaker()
    opossum.open()

    bench('open: decorate(breaker, op)', async () => {
      await decorated().catch(ignore)
    })
    bench('open: decorate(breaker, op), captureStackTrace', async () => {
      await withStack().catch(ignore)
    })
    bench('open: cockatiel breaker', async () => {
      await cockatiel.execute(op).catch(ignore)
    })
    bench('open: opossum breaker', async () => {
      await opossum.fire().catch(ignore)
    })
  })
})

// Half the calls fail, below every breaker's threshold here, so none of them ever opens. The error is created once,
// so its stack capture is not what is measured.
const down = new Error('down')
let calls = 0
const flaky = async (): Promise<number> => {
  if (++calls & 1) {
    throw down
  }
  return 1
}

group('failure path, breaker closed', () => {
  summary(() => {
    const decorated = decorate(circuitBreaker({ name: 'bench', failureRateThreshold: 100 }), flaky)
    const wrapped = circuitBreaker({ name: 'bench', failureRateThreshold: 100 }).wrap(flaky)
    const cockatiel = cockatielBreaker(handleAll, { halfOpenAfter: 60_000, breaker: new ConsecutiveBreaker(1e9) })
    const opossum = new CircuitBreaker(flaky, { timeout: false, errorThresholdPercentage: 100, resetTimeout: 60_000 })
    opossumBreakers.push(opossum)

    bench('failure: decorate(breaker, op)', async () => {
      await decorated().catch(ignore)
    })
    bench('failure: breaker.wrap(op)', async () => {
      await wrapped(ctx).catch(ignore)
    })
    bench('failure: cockatiel breaker', async () => {
      await cockatiel.execute(flaky).catch(ignore)
    })
    bench('failure: opossum breaker', async () => {
      await opossum.fire().catch(ignore)
    })
  })
})

group('breaker, with a success listener', () => {
  summary(() => {
    const plain = decorate(caffeineBreaker(), op)
    const observed = caffeineBreaker()
    observed.on('success', () => undefined)
    const listened = decorate(observed, op)

    bench('listener: decorate(breaker, op), no listener', async () => {
      await plain()
    })
    bench('listener: decorate(breaker, op), one success listener', async () => {
      await listened()
    })
  })
})

// One policy at a time, then the recommended chain, so a change to one policy's `wrap` shows in its own line.
group('time limiter, bulkhead, rate limiter and fallback, success path', () => {
  summary(() => {
    const limited = decorate(timeLimiter({ name: 'bench', timeoutDuration: 1 * Second }), op)
    const pooled = decorate(bulkhead({ name: 'bench', maxConcurrentCalls: 1_000 }), op)
    const quota = decorate(rateLimiter({ name: 'bench', limitForPeriod: 1e12, limitRefreshPeriod: 1 * Hour }), op)
    const stale = decorate(fallback(ignore, { name: 'bench' }), op)
    const chain = decorate(
      compose(
        caffeineRetry(),
        caffeineBreaker(),
        rateLimiter({ name: 'bench', limitForPeriod: 1e12, limitRefreshPeriod: 1 * Hour }),
        bulkhead({ name: 'bench', maxConcurrentCalls: 1_000 }),
        timeLimiter({ name: 'bench', timeoutDuration: 1 * Second }),
      ),
      op,
    )

    bench('new: decorate(timeLimiter, op)', async () => {
      await limited()
    })
    bench('new: decorate(bulkhead, op)', async () => {
      await pooled()
    })
    bench('new: decorate(rateLimiter, op)', async () => {
      await quota()
    })
    bench('new: decorate(fallback, op)', async () => {
      await stale()
    })
    bench('new: decorate(compose(retry, breaker, rateLimiter, bulkhead, timeLimiter), op)', async () => {
      await chain()
    })
  })
})

// A caller's signal makes the time limiter combine it with its own on every call: once with a signal per call, as a
// request handler passes, and once with one signal that outlives every call, as a worker's shutdown signal does.
group('time limiter with a caller signal, success path', () => {
  summary(() => {
    const limited = decorate(
      timeLimiter({ name: 'bench', timeoutDuration: 1 * Second }),
      async (signal: AbortSignal): Promise<number> => (signal.aborted ? 0 : 1),
    )
    const shutdown = new AbortController().signal

    bench('signal: decorate(timeLimiter, op), a signal per call', async () => {
      await limited(new AbortController().signal)
    })
    bench('signal: decorate(timeLimiter, op), one long-lived signal', async () => {
      await limited(shutdown)
    })
  })
})

await run({ colors: process.stdout.isTTY === true })

for (const breaker of opossumBreakers) {
  breaker.shutdown()
}
