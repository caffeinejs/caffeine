import { circuitBreaker, compose, retry, runWith } from '@caffeinejs/resilience'
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

// The protected operation does no work, so every nanosecond measured is the strategy's own overhead.
const op = async (): Promise<number> => 1
const ignore = (): void => undefined

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
    const runWithBreaker = caffeineBreaker()
    const composed = compose(caffeineBreaker())
    const cockatiel = cockatielBreakerPolicy()
    const opossum = opossumBreaker()

    bench('success: raw call', async () => {
      await op()
    })
    bench('success: runWith(op, breaker)', async () => {
      await runWith(op, runWithBreaker)
    })
    bench('success: compose(breaker)', async () => {
      await composed(op)
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
    const retries = caffeineRetry()
    const breaker = caffeineBreaker()
    const composed = compose(caffeineRetry(), caffeineBreaker())
    const cockatiel = wrap(cockatielRetryPolicy(), cockatielBreakerPolicy())

    bench('retry+breaker: runWith(op, retries, breaker)', async () => {
      await runWith(op, retries, breaker)
    })
    bench('retry+breaker: compose(retries, breaker)', async () => {
      await composed(op)
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
    const composed = compose(caffeine)
    const stackCapturing = circuitBreaker({ name: 'bench', captureStackTrace: true })
    stackCapturing.forceOpen()
    const withStack = compose(stackCapturing)
    const cockatiel = cockatielBreakerPolicy()
    cockatiel.isolate()
    const opossum = opossumBreaker()
    opossum.open()

    bench('open: compose(breaker)', async () => {
      await composed(op).catch(ignore)
    })
    bench('open: compose(breaker), captureStackTrace', async () => {
      await withStack(op).catch(ignore)
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
    const runWithBreaker = circuitBreaker({ name: 'bench', failureRateThreshold: 100 })
    const composed = compose(circuitBreaker({ name: 'bench', failureRateThreshold: 100 }))
    const cockatiel = cockatielBreaker(handleAll, { halfOpenAfter: 60_000, breaker: new ConsecutiveBreaker(1e9) })
    const opossum = new CircuitBreaker(flaky, { timeout: false, errorThresholdPercentage: 100, resetTimeout: 60_000 })
    opossumBreakers.push(opossum)

    bench('failure: runWith(op, breaker)', async () => {
      await runWith(flaky, runWithBreaker).catch(ignore)
    })
    bench('failure: compose(breaker)', async () => {
      await composed(flaky).catch(ignore)
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
    const plain = compose(caffeineBreaker())
    const observed = caffeineBreaker()
    observed.on('success', () => undefined)
    const listened = compose(observed)

    bench('listener: compose(breaker), no listener', async () => {
      await plain(op)
    })
    bench('listener: compose(breaker), one success listener', async () => {
      await listened(op)
    })
  })
})

await run({ colors: process.stdout.isTTY === true })

for (const breaker of opossumBreakers) {
  breaker.shutdown()
}
