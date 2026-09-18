# @caffeinejs/resilience

Circuit breaker and retry for any JavaScript runtime, composed as plain functions. No dependencies; the
OpenTelemetry binding is an optional subpath.

```sh
npm install @caffeinejs/resilience
```

## Quick start

Strategies hold state (a circuit breaker remembers recent calls), so create each one **once** per protected
dependency and share it. A breaker created per call never sees a second call and never opens.

```ts
import { circuitBreaker, exponential, retry, runWith } from '@caffeinejs/resilience'

// module scope
const breaker = circuitBreaker({
  name: 'inventory',
  failureRateThreshold: 50,
  slidingWindow: { type: 'count', size: 20 },
})
const retries = retry({
  name: 'inventory',
  maxAttempts: 3,
  backoff: exponential({ initialDelayMs: 100, maxDelayMs: 2_000, jitter: 0.5 }),
})

const fetchStock = (id: string, signal?: AbortSignal) =>
  fetch(`https://inventory/stock/${id}`, { signal }).then(r => r.json() as Promise<Stock>)

// per call
const stock = await runWith(() => fetchStock(id), retries, breaker) // Promise<Stock>
```

The result is always a promise. A synchronous operation is fine: its value or its throw settles the promise.

## Order of strategies

Strategies are listed from the outermost to the innermost: `runWith(op, a, b, c)` runs `a(b(c(op)))`.

```ts
// retry around the breaker: each attempt is one breaker call; an open breaker fails the call at once
await runWith(op, retries, breaker)

// breaker around the retry: one breaker call per whole retry sequence
await runWith(op, breaker, retries)
```

The first is the usual choice.

## Cancellation

The operation receives a context with the caller's signal and the attempt number. Pass the signal, bare, after
the strategies; `undefined` means no signal, so an optional signal passes straight through.

```ts
const stock = await runWith(({ signal }) => fetchStock(id, signal), retries, breaker, request.signal)

const getStock = (id: string, signal?: AbortSignal) =>
  runWith(ctx => fetchStock(id, ctx.signal), retries, breaker, signal)
```

- An already-aborted signal rejects with its reason without running anything.
- An abort during a retry's wait rejects at once with the abort reason; no further attempt runs.
- A failure that settles after the caller aborted is not counted against the dependency.
- `ctx.attempt` starts at 1; a retry increments it.

Each retry that is waiting holds one `abort` listener on the signal until it wakes. Many calls waiting on one
long-lived signal, such as a server's shutdown signal, trigger Node's `MaxListenersExceededWarning` at 11
listeners. Prefer a signal per request.

## Fallback

The promise settles after the whole chain, with the final error: the last attempt's error after retries, or
`ErrCallNotPermitted` when a breaker refused the call. A fallback is a `.catch()`:

```ts
import { ErrCallNotPermitted } from '@caffeinejs/resilience'

// any failure
const stock = await runWith(() => fetchStock(id), retries, breaker).catch(() => cachedStock(id))

// only when the breaker refuses the call
const stock = await runWith(() => fetchStock(id), retries, breaker).catch(error => {
  if (error instanceof ErrCallNotPermitted) {
    return cachedStock(id)
  }
  throw error
})
```

`ErrCallNotPermitted.retryAfterMs` tells an HTTP layer what to put in `Retry-After`:

```ts
if (error instanceof ErrCallNotPermitted && error.retryAfterMs !== undefined) {
  reply.header('retry-after', Math.ceil(error.retryAfterMs / 1000)).code(503)
}
```

## Reusing a chain with `compose()`

`runWith()` builds its chain on every call. `compose()` builds it once and returns a function with the same
contract minus the strategy list; use it wherever the same strategies protect many calls.

```ts
import { compose } from '@caffeinejs/resilience'

export const inventory = compose(retries, breaker)

const stock = await inventory(() => fetchStock(id))
const fresh = await inventory(({ signal }) => fetchStock(id, signal), request.signal)

export const getStock = (id: string, signal?: AbortSignal) =>
  inventory(ctx => fetchStock(id, ctx.signal), signal).catch(() => cachedStock(id))
```

One runner is safe to call concurrently: each call has its own context, and only the strategies' state is
shared.

## Circuit breaker

```ts
const breaker = circuitBreaker({
  name: 'payments',
  slidingWindow: { type: 'time', seconds: 30 },
  minimumNumberOfCalls: 20,
  slowCallDurationThresholdMs: 2_000,
  slowCallRateThreshold: 80,
  recordResult: res => res instanceof Response && res.status >= 500,
  ignoreError: err => err instanceof ValidationError,
})
```

| Option                                  | Default                        | Meaning                                                                                   |
| --------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| `name`                                  | required                       | Names the breaker in errors, events and metrics                                           |
| `failureRateThreshold`                  | `50`                           | Failure rate, in percent, at or above which the breaker opens                             |
| `slowCallRateThreshold`                 | `100`                          | Slow-call rate, in percent, at or above which the breaker opens                           |
| `slowCallDurationThresholdMs`           | `60_000`                       | A call longer than this is slow                                                           |
| `slidingWindow`                         | `{ type: 'count', size: 100 }` | The last `size` calls, or `{ type: 'time', seconds }` for the calls of the last seconds   |
| `minimumNumberOfCalls`                  | `100`                          | Calls needed before a rate is computed; capped at a count window's size                   |
| `waitDurationInOpenStateMs`             | `60_000`                       | Time spent open; a function of how many times in a row it opened, such as `exponential()` |
| `permittedNumberOfCallsInHalfOpenState` | `10`                           | Trial calls let through while half open                                                   |
| `maxWaitDurationInHalfOpenStateMs`      | `0` (forever)                  | Re-opens a half-open breaker whose trial calls never settle                               |
| `automaticTransitionFromOpenToHalfOpen` | `false`                        | Moves to half open when the wait elapses, not on the next call                            |
| `recordError`                           | every error                    | Whether an error is a failure; `false` counts it as a success                             |
| `ignoreError`                           | none                           | Errors that neither count nor affect the state; checked first                             |
| `recordResult`                          | none                           | Whether a returned value is a failure                                                     |
| `captureStackTrace`                     | `false`                        | Whether a refusal's `ErrCallNotPermitted` captures a stack trace                          |

How it moves:

- **closed**: calls run and are recorded. Once the window holds `minimumNumberOfCalls`, a failure rate or a
  slow-call rate at its threshold opens the breaker.
- **open**: calls are refused with `ErrCallNotPermitted` until the wait elapses; then the next call finds it
  half open.
- **half_open**: `permittedNumberOfCallsInHalfOpenState` trial calls run, the rest are refused. Their outcome
  closes the breaker or opens it again, for a wait computed from how many times in a row it opened.
- **forced_open**, **disabled**, **metrics_only**: manual states entered with `forceOpen()`, `disable()` and
  `metricsOnly()`, left with `reset()`. Disabled lets everything through and records nothing; metrics-only
  records and reports but never opens.

A call's outcome counts only for the state it started in: a call that settles after the breaker changed state,
or after `reset()`, is reported in events but not recorded.

`breaker.metrics()` returns a snapshot: `failureRate` and `slowCallRate` in percent (`undefined` below the
minimum number of calls), `bufferedCalls`, `failedCalls`, `successfulCalls`, `slowCalls`, `slowFailedCalls`,
`slowSuccessfulCalls`, and `notPermittedCalls`, which counts every refusal since creation and survives `reset()`.

## Retry

```ts
const retries = retry({
  name: 'payments',
  maxAttempts: 4,
  retryOnResult: res => res instanceof Response && res.status === 503,
  backoff: (attempt, error, result) =>
    result instanceof Response && result.headers.has('retry-after')
      ? Number(result.headers.get('retry-after')) * 1_000
      : 200 * 2 ** (attempt - 1),
  failAfterMaxAttempts: true,
})
```

| Option                 | Default                                  | Meaning                                                                               |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| `name`                 | required                                 | Names the retry in errors, events and metrics                                         |
| `maxAttempts`          | `3`                                      | Attempts in total, the first call included                                            |
| `backoff`              | `500`                                    | Milliseconds between attempts, or `(attempt, error, result) => ms`                    |
| `retryOn`              | every error except `ErrCallNotPermitted` | Whether an error is worth another attempt; a function given here replaces the default |
| `retryOnResult`        | none                                     | Whether a returned value is worth another attempt                                     |
| `failAfterMaxAttempts` | `false`                                  | Reject with `ErrMaxRetriesExceeded` instead of returning the last retryable value     |

Once every attempt is used, the caller gets the last error unchanged. Delays are clamped to what timers can hold
(about 24.8 days); a delay that is not a finite number rejects the call with `ErrInvalidOption`.

`retries.metrics()` counts each call once: `successfulCallsWithoutRetry`, `successfulCallsWithRetry`,
`failedCallsWithoutRetry`, `failedCallsWithRetry`.

## Backoff

`exponential({ initialDelayMs = 500, multiplier = 2, maxDelayMs = 30_000, jitter = 0 })` returns
`attempt => delay`: `initialDelayMs · multiplier^(attempt−1)`, randomized to within `±jitter` of itself for
`jitter` in `[0, 1)`, then capped at `maxDelayMs`. It fits both `retry({ backoff })` and
`circuitBreaker({ waitDurationInOpenStateMs })`.

## Errors

| Error                   | `code`                     | When                                                                                      |
| ----------------------- | -------------------------- | ----------------------------------------------------------------------------------------- |
| `ErrCallNotPermitted`   | `ERR_CALL_NOT_PERMITTED`   | A breaker refused the call. `breaker`, `state`, and `retryAfterMs` when `state` is `open` |
| `ErrMaxRetriesExceeded` | `ERR_MAX_RETRIES_EXCEEDED` | `failAfterMaxAttempts` and the last value was still retryable. `attempts`, `result`       |
| `ErrInvalidOption`      | `ERR_INVALID_OPTION`       | A factory, `compose()` or `runWith()` got a bad argument; or a computed delay is unusable |

All extend `ErrResilience`.

`ErrCallNotPermitted` carries no stack trace by default: refusals arrive in bulk while a dependency is down, capturing
a stack costs several times the rest of the refusal, and `breaker` and `state` already say why the call failed. Pass
`captureStackTrace: true` to the breaker to get one.

## Events

```ts
const off = breaker.on('stateChange', e => log.warn({ breaker: e.name, from: e.from, to: e.to }, 'circuit breaker'))
retries.on('retry', e => log.info({ retry: e.name, attempt: e.attempt, delayMs: e.delayMs }, 'retrying'))
off()
```

| Strategy        | Events                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| circuit breaker | `success`, `failure`, `ignored`, `notPermitted`, `stateChange`, `reset`, `failureRateExceeded`, `slowCallRateExceeded` |
| retry           | `retry` (before each wait), `success`, `failure` (every attempt used), `ignored` (not retryable, or aborted)           |

Every payload carries the strategy's `name`. Listeners run synchronously. A listener that throws, or returns a
promise that rejects, never changes the outcome of the call; its error is rethrown on the next microtask, where
the runtime reports it as uncaught (in Node, that ends the process by default). Listeners must not throw.

## OpenTelemetry

```sh
npm install @opentelemetry/api
```

```ts
import { instrumentCircuitBreaker, instrumentRetry } from '@caffeinejs/resilience/otel'

const stopBreaker = instrumentCircuitBreaker(breaker) // global MeterProvider
const stopRetry = instrumentRetry(retries, { meterProvider }) // or a provider of your own

stopBreaker()
stopRetry()
```

Instruments are created under the scope `@caffeinejs/resilience`. Strategies sharing a `name` share series.

| Metric                                           | Instrument                 | Unit     | Attributes                                                                                                                                          |
| ------------------------------------------------ | -------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resilience.circuit_breaker.call.duration`       | Histogram                  | `s`      | name, `resilience.circuit_breaker.kind` (`successful`, `failed`, `ignored`), `error.type` when failed                                               |
| `resilience.circuit_breaker.not_permitted_calls` | Observable counter         | `{call}` | name                                                                                                                                                |
| `resilience.circuit_breaker.state`               | Observable up-down counter | `1`      | name, `resilience.circuit_breaker.state`: 1 for the current state, 0 for the others                                                                 |
| `resilience.circuit_breaker.buffered_calls`      | Observable up-down counter | `{call}` | name, kind (`successful`, `failed`)                                                                                                                 |
| `resilience.circuit_breaker.slow_calls`          | Observable up-down counter | `{call}` | name, kind (`successful`, `failed`)                                                                                                                 |
| `resilience.circuit_breaker.failure_rate`        | Observable gauge           | `1`      | name; 0 to 1, absent below the minimum number of calls                                                                                              |
| `resilience.circuit_breaker.slow_call_rate`      | Observable gauge           | `1`      | name; 0 to 1, absent below the minimum number of calls                                                                                              |
| `resilience.retry.calls`                         | Observable counter         | `{call}` | `resilience.retry.name`, `resilience.retry.kind` (`successful_without_retry`, `successful_with_retry`, `failed_without_retry`, `failed_with_retry`) |

The breaker's name attribute is `resilience.circuit_breaker.name`. The duration histogram advises bucket
boundaries from 5 ms to 60 s.

Through the OpenTelemetry Prometheus exporter for JavaScript, dots become underscores and counters gain `_total`:
`resilience_circuit_breaker_call_duration` (with `_bucket`, `_sum` and `_count`),
`resilience_circuit_breaker_not_permitted_calls_total`, `resilience_retry_calls_total`, and so on. Other
pipelines, such as the OpenTelemetry Collector's Prometheus exporter, may also append the unit (`_seconds`).

## Writing a strategy

A strategy is a function of the call's context and the rest of the chain:

```ts
import type { Strategy } from '@caffeinejs/resilience'

const timing: Strategy = async (ctx, next) => {
  const start = performance.now()
  try {
    return await next(ctx)
  } finally {
    histogram.record(performance.now() - start, { attempt: ctx.attempt })
  }
}

await runWith(op, retries, timing, breaker) // times each attempt, inside the retry
```

`next` always returns a promise and never throws synchronously, whatever the strategies inside it do, so chaining
`.then()` or `.finally()` on it is safe.

To hand the rest of the chain a different signal, derive the context with `ctx.with()`; a context built any other
way cannot reach the operation.

```ts
const deadline: Strategy = (ctx, next) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  return next(ctx.with({ signal: controller.signal })).finally(() => clearTimeout(timer))
}
```

A strategy with state is an object with a `run` method, called with the object as `this`:

```ts
import type { ExecutionContext, Next, StrategyObject } from '@caffeinejs/resilience'

class Counting implements StrategyObject {
  calls = 0

  run<T>(ctx: ExecutionContext, next: Next<T>): Promise<T> {
    this.calls++
    return next(ctx)
  }
}
```
