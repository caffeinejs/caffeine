# @caffeinejs/resilience

Circuit breaker, retry, time limiter, bulkhead, rate limiter and fallback for any JavaScript runtime, composed as
plain functions. Its one dependency is `@caffeinejs/std`, which has none; every integration is an optional subpath.

```sh
npm install @caffeinejs/resilience
```

| Import from                             | What                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `@caffeinejs/resilience`                | `compose`, `runWith`, `exponential`, the strategy types, shared errors |
| `@caffeinejs/resilience/circuitbreaker` | `circuitBreaker`, `ErrCallNotPermitted`                                |
| `@caffeinejs/resilience/retry`          | `retry`, `ErrMaxRetriesExceeded`                                       |
| `@caffeinejs/resilience/timelimiter`    | `timeLimiter`, `ErrTimeLimitExceeded`                                  |
| `@caffeinejs/resilience/bulkhead`       | `bulkhead`, `ErrBulkheadFull`                                          |
| `@caffeinejs/resilience/ratelimiter`    | `rateLimiter`, `ErrRateLimitExceeded`                                  |
| `@caffeinejs/resilience/fallback`       | `fallback`                                                             |
| `@caffeinejs/resilience/otel`           | OpenTelemetry instruments, with `@opentelemetry/api` installed         |

## Quick start

Strategies hold state (a circuit breaker remembers recent calls), so create each one **once** per protected
dependency and share it. A breaker created per call never sees a second call and never opens.

```ts
import { exponential, runWith } from '@caffeinejs/resilience'
import { circuitBreaker } from '@caffeinejs/resilience/circuitbreaker'
import { retry } from '@caffeinejs/resilience/retry'
import { Millisecond, Second } from '@caffeinejs/std/duration'

// module scope
const breaker = circuitBreaker({
  name: 'inventory',
  failureRateThreshold: 50,
  slidingWindow: { type: 'count', size: 20 },
})
const retries = retry({
  name: 'inventory',
  maxAttempts: 3,
  backoff: exponential({ initialDelay: 100 * Millisecond, maxDelay: 2 * Second, jitter: 0.5 }),
})

const fetchStock = (id: string, signal?: AbortSignal) =>
  fetch(`https://inventory/stock/${id}`, { signal }).then(r => r.json() as Promise<Stock>)

// per call
const stock = await runWith(() => fetchStock(id), retries, breaker) // Promise<Stock>
```

The result is always a promise. A synchronous operation is fine: its value or its throw settles the promise.

Every delay, wait and threshold is a `Duration` from `@caffeinejs/std/duration`, a number of milliseconds written
with its constants: `2 * Second`, `500 * Millisecond`.

## Order of strategies

Strategies are listed from the outermost to the innermost: `runWith(op, a, b, c)` runs `a(b(c(op)))`.

```ts
// retry around the breaker: each attempt is one breaker call; an open breaker fails the call at once
await runWith(op, retries, breaker)

// breaker around the retry: one breaker call per whole retry sequence
await runWith(op, breaker, retries)
```

The first is the usual choice. With every strategy, the recommended order is:

```ts
import { compose } from '@caffeinejs/resilience'

const inventory = compose(retries, breaker, quota, deadline, pool)
// retry( circuitBreaker( rateLimiter( timeLimiter( bulkhead( operation )))))
```

- The retry repeats the whole inner chain; an open breaker, a full bulkhead or a spent quota fails the call at once.
- The breaker records each attempt, a timeout included.
- The rate limiter counts attempts against the quota.
- The time limiter bounds each attempt, and the time it spends waiting for a bulkhead slot.
- The bulkhead holds a slot while the operation runs.

A fallback answers for the whole call, outside the chain: see [Fallback](#fallback).

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

The promise settles after the whole chain, with the final error: the last attempt's error after retries, or a
refusal such as `ErrCallNotPermitted`. A fallback answers it with something else, such as a cached value.

```ts
import { compose, ErrCallRefused } from '@caffeinejs/resilience'
import { fallback } from '@caffeinejs/resilience/fallback'

// module scope
const inventory = compose(retries, breaker, deadline)
const staleStock = fallback({
  name: 'inventory',
  fallbackOn: error => error instanceof ErrCallRefused, // only calls that certainly never ran
})

// per call: Promise<Stock | CachedStock>
export const getStock = (id: string, signal?: AbortSignal) =>
  staleStock.recover(
    inventory(ctx => fetchStock(id, ctx.signal), signal),
    error => cachedStock(id),
    signal,
  )
```

| Option       | Default     | Meaning                                   |
| ------------ | ----------- | ----------------------------------------- |
| `name`       | required    | Names the fallback in events and metrics  |
| `fallbackOn` | every error | Whether an error is handed to the handler |

`recover(call, handler, signal?)` returns the call's value, or the handler's for an error `fallbackOn` accepts. The
handler is given per call because a useful fallback needs the call's own data, such as the id to look up.

- An error `fallbackOn` declines passes through unchanged, so a bug is not hidden as an outage.
- Once `signal` has aborted, the handler never runs: nobody is waiting for the value.
- A handler that throws rejects the call with what it threw.
- A `fallbackOn` that returns anything but a boolean rejects the call with `ErrInvalidOption`.

A timeout leaves the outcome unknown: the call may have gone through. Limiting a fallback to `ErrCallRefused`
answers only the calls that never ran, which matters for writes such as payments.

`.catch()` still works for a one-off; `fallback()` adds a shared filter, abort awareness, events and metrics.

`ErrCallRefused.retryAfter` tells an HTTP layer what to put in `Retry-After`, which counts seconds:

```ts
if (error instanceof ErrCallRefused && error.retryAfter !== undefined) {
  reply.header('retry-after', Math.ceil(error.retryAfter / Second)).code(503)
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
  slidingWindow: { type: 'time', duration: 30 * Second },
  minimumNumberOfCalls: 20,
  slowCallDurationThreshold: 2 * Second,
  slowCallRateThreshold: 80,
  recordResult: res => res instanceof Response && res.status >= 500,
  ignoreError: err => err instanceof ValidationError,
})
```

| Option                                  | Default                        | Meaning                                                                                                          |
| --------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `name`                                  | required                       | Names the breaker in errors, events and metrics                                                                  |
| `failureRateThreshold`                  | `50`                           | Failure rate, in percent, at or above which the breaker opens                                                    |
| `slowCallRateThreshold`                 | `100`                          | Slow-call rate, in percent, at or above which the breaker opens                                                  |
| `slowCallDurationThreshold`             | `1 * Minute`                   | A call longer than this is slow                                                                                  |
| `slidingWindow`                         | `{ type: 'count', size: 100 }` | The last `size` calls, or `{ type: 'time', duration }` for the calls of the last `duration`, in whole seconds    |
| `minimumNumberOfCalls`                  | `100`                          | Calls needed before a rate is computed; capped at a count window's size                                          |
| `waitDurationInOpenState`               | `1 * Minute`                   | Time spent open; a function of how many times in a row it opened, such as `exponential()`                        |
| `permittedNumberOfCallsInHalfOpenState` | `10`                           | Trial calls let through while half open                                                                          |
| `maxWaitDurationInHalfOpenState`        | `0` (forever)                  | Re-opens a half-open breaker whose trial calls never settle                                                      |
| `automaticTransitionFromOpenToHalfOpen` | `false`                        | Moves to half open when the wait elapses, not on the next call                                                   |
| `recordError`                           | every error                    | Whether an error is a failure; `false` counts it as a success                                                    |
| `ignoreError`                           | none                           | Errors that neither count nor affect the state; checked first. Refusals from inside and aborted calls always are |
| `recordResult`                          | none                           | Whether a returned value is a failure                                                                            |
| `captureStackTrace`                     | `false`                        | Whether a refusal's `ErrCallNotPermitted` captures a stack trace                                                 |

How it moves:

- **closed**: calls run and are recorded. Once the window holds `minimumNumberOfCalls`, a failure rate or a
  slow-call rate at its threshold opens the breaker.
- **open**: calls are refused with `ErrCallNotPermitted` until the wait elapses; then the next call finds it
  half open.
- **half_open**: `permittedNumberOfCallsInHalfOpenState` trial calls run, the rest are refused. Their outcome
  closes the breaker or opens it again, for a wait computed from how many times in a row it opened. With
  `maxWaitDurationInHalfOpenState`, once every trial slot has been held that long, the next call re-opens the
  breaker. Time with a free slot does not count.
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
      ? Number(result.headers.get('retry-after')) * Second
      : 200 * Millisecond * 2 ** (attempt - 1),
  failAfterMaxAttempts: true,
})
```

| Option                 | Default         | Meaning                                                                           |
| ---------------------- | --------------- | --------------------------------------------------------------------------------- |
| `name`                 | required        | Names the retry in errors, events and metrics                                     |
| `maxAttempts`          | `3`             | Attempts in total, the first call included                                        |
| `backoff`              | `exponential()` | The wait between attempts, or `(attempt, error, result) => Duration`              |
| `retryOn`              | every error     | Whether an error is worth another attempt; refusals and aborted calls never are   |
| `retryOnResult`        | none            | Whether a returned value is worth another attempt                                 |
| `failAfterMaxAttempts` | `false`         | Reject with `ErrMaxRetriesExceeded` instead of returning the last retryable value |

A refusal, any `ErrCallRefused` such as an open breaker's `ErrCallNotPermitted`, is never retried, and neither is a
failure after the caller aborted, whatever `retryOn` returns: a refusal means the operation never ran, and retrying
it at once only adds load to what is already refusing. `retryOn` narrows what is retried; it cannot widen it.

The default backoff waits 500 ms, doubling per attempt up to 30 s, each wait spread by half of it either way, so
callers that failed together do not come back together. Pass `backoff: exponential({ jitter: 0 })`, or a fixed
`Duration`, to wait exactly.

Once every attempt is used, the caller gets the last error unchanged. A call that used every attempt on a
retryable result counts as failed and emits `failure`, whether or not `failAfterMaxAttempts` is set. A `retryOn`,
`retryOnResult` or `backoff` that throws rejects the call with what it threw, and the call counts as failed. A
`retryOn` or `retryOnResult` that returns anything but a boolean, such as the promise an `async` predicate returns,
rejects the call with `ErrInvalidOption`. Delays are clamped to what timers can hold (about 24.8 days); a delay that
is not a finite number rejects the call with `ErrInvalidOption`.

`retries.metrics()` counts each call once: `successfulCallsWithoutRetry`, `successfulCallsWithRetry`,
`failedCallsWithoutRetry`, `failedCallsWithRetry`.

## Time limiter

```ts
import { timeLimiter } from '@caffeinejs/resilience/timelimiter'

const deadline = timeLimiter({ name: 'inventory', timeoutDuration: 2 * Second })

await runWith(({ signal }) => fetchStock(id, signal), retries, breaker, deadline)
```

| Option            | Default  | Meaning                                                             |
| ----------------- | -------- | ------------------------------------------------------------------- |
| `name`            | required | Names the time limiter in errors, events and metrics                |
| `timeoutDuration` | required | How long the rest of the chain may run; finite and greater than `0` |

The rest of the chain gets a signal of its own, linked to the caller's. When the limit passes, that signal aborts
with an `ErrTimeLimitExceeded` and the call rejects with it at once, even when the operation ignores its signal and
never settles. When the caller aborts first, the call rejects with the caller's reason and no timeout is counted.

A timeout cannot undo work: an operation that ignores its signal keeps running after the call rejected, and a
retried write can overlap the one still in flight. Pass the signal to every I/O call, and make writes idempotent.

Where it sits decides what it bounds:

```ts
// per attempt: each of the 3 attempts gets 2 s; the breaker records each timeout
await runWith(op, retries, breaker, deadline)

// total: 5 s for every attempt and every wait between them
const total = timeLimiter({ name: 'inventory-total', timeoutDuration: 5 * Second })
await runWith(op, total, retries, breaker, deadline)
```

`deadline.metrics()` counts `successfulCalls`, `failedCalls` and `timedOutCalls`. The timer keeps the process
alive: it is what settles a call whose operation ignores its signal.

## Bulkhead

```ts
import { bulkhead } from '@caffeinejs/resilience/bulkhead'

const pool = bulkhead({
  name: 'payments',
  maxConcurrentCalls: 10,
  maxWaitDuration: 200 * Millisecond,
  maxQueuedCalls: 50,
})
```

| Option               | Default              | Meaning                                                              |
| -------------------- | -------------------- | -------------------------------------------------------------------- |
| `name`               | required             | Names the bulkhead in errors, events and metrics                     |
| `maxConcurrentCalls` | `25`                 | Calls allowed to run at once                                         |
| `maxWaitDuration`    | `0`                  | How long a call may wait for a slot; `0` refuses at once             |
| `maxQueuedCalls`     | `maxConcurrentCalls` | How many calls may wait at once, when `maxWaitDuration` is above `0` |
| `captureStackTrace`  | `false`              | Whether a refusal's `ErrBulkheadFull` captures a stack trace         |

A slow dependency can use up every request a process serves before enough calls settle for a breaker to open. A
bulkhead caps the calls in flight: past the cap, a call waits in line, first come first served, for at most
`maxWaitDuration` with at most `maxQueuedCalls` waiting, or is refused with `ErrBulkheadFull`. A waiting call whose
signal aborts leaves the line.

A slot is given back when the rest of the chain settles, never earlier. A time limiter outside the bulkhead that gave
up on a call does not free its slot while the operation is still running: the bulkhead counts work really in flight.

`pool.metrics()` reports `availableConcurrentCalls`, `maxAllowedConcurrentCalls`, `queuedCalls` and
`rejectedCalls`.

## Rate limiter

```ts
import { rateLimiter } from '@caffeinejs/resilience/ratelimiter'

const quota = rateLimiter({
  name: 'partner-api',
  limitForPeriod: 100,
  limitRefreshPeriod: 1 * Second,
  maxWaitDuration: 500 * Millisecond,
})
```

| Option               | Default  | Meaning                                                              |
| -------------------- | -------- | -------------------------------------------------------------------- |
| `name`               | required | Names the rate limiter in errors, events and metrics                 |
| `limitForPeriod`     | required | Calls that may start in each period                                  |
| `limitRefreshPeriod` | required | The length of a period                                               |
| `maxWaitDuration`    | `0`      | How long a call may wait for a permit of a later period; `0` refuses |
| `captureStackTrace`  | `false`  | Whether a refusal's `ErrRateLimitExceeded` captures a stack trace    |

At most `limitForPeriod` calls start in each period, periods counted from when the rate limiter was created. A call
that finds no permit left reserves one of a later period when it would get it within `maxWaitDuration`, and starts
then; calls are served in the order they reserved. Otherwise it is refused with `ErrRateLimitExceeded`, whose
`retryAfter` says when its permit would have come. A waiting call whose signal aborts leaves the line; its permit is
spent, unless it was the last in line, which gives its permit back. No timer runs while nobody waits.

Permits are counted per period reserved: on an event loop too busy to start a waiting call in its period, the call
starts later on the permit it reserved, ahead of any call that arrived after it.

The limit holds in this process only. Ten replicas that each allow 100 calls a second allow 1,000 between them:
divide a partner's quota by the replica count, or enforce it where the calls leave your network.

`quota.metrics()` reports `availablePermissions`, `waitingCalls` and `rejectedCalls`.

## Backoff

`exponential({ initialDelay = 500 * Millisecond, multiplier = 2, maxDelay = 30 * Second, jitter = 0.5 })` returns
`attempt => delay`: `initialDelay · multiplier^(attempt−1)`, capped at `maxDelay`, then randomized to within
`±jitter` of itself for `jitter` in `[0, 1)` without passing the cap. A delay that reached the cap is spread over
`[maxDelay·(1−jitter), maxDelay]`, so clients that back off for long still wait different times. It fits both
`retry({ backoff })` and `circuitBreaker({ waitDurationInOpenState })`.

## Errors

| Error                   | From              | `code`                     | When                                                                                      |
| ----------------------- | ----------------- | -------------------------- | ----------------------------------------------------------------------------------------- |
| `ErrCallNotPermitted`   | `/circuitbreaker` | `ERR_CALL_NOT_PERMITTED`   | A breaker refused the call. `breaker`, `state`, and `retryAfter` when `state` is `open`   |
| `ErrBulkheadFull`       | `/bulkhead`       | `ERR_BULKHEAD_FULL`        | No slot, and no room or time to wait for one. `bulkhead`                                  |
| `ErrRateLimitExceeded`  | `/ratelimiter`    | `ERR_RATE_LIMIT_EXCEEDED`  | No permit within `maxWaitDuration`. `rateLimiter`, `retryAfter`                           |
| `ErrTimeLimitExceeded`  | `/timelimiter`    | `ERR_TIME_LIMIT_EXCEEDED`  | The rest of the chain ran past the limit. `timeLimiter`, `timeoutDuration`                |
| `ErrMaxRetriesExceeded` | `/retry`          | `ERR_MAX_RETRIES_EXCEEDED` | `failAfterMaxAttempts` and the last value was still retryable. `attempts`, `result`       |
| `ErrInvalidOption`      | root              | `ERR_INVALID_OPTION`       | A factory, `compose()` or `runWith()` got a bad argument; or a computed delay is unusable |

All extend `ErrResilience`. A refusal, a call a strategy turned away without running it, extends `ErrCallRefused`,
which carries `retryAfter` when the strategy knows how long to wait: catch `ErrCallRefused` to handle every kind of
refusal at once. `ErrCallNotPermitted`, `ErrBulkheadFull` and `ErrRateLimitExceeded` are refusals;
`ErrTimeLimitExceeded` is not, because the operation ran.

Refusals carry no stack trace by default: they arrive in bulk while a dependency is down, capturing a stack costs
several times the rest of the refusal, and their fields already say why the call failed. Pass
`captureStackTrace: true` to the strategy to get one.

## Events

```ts
const off = breaker.on('stateChange', e => log.warn({ breaker: e.name, from: e.from, to: e.to }, 'circuit breaker'))
retries.on('retry', e => log.info({ retry: e.name, attempt: e.attempt, delayMs: e.delay }, 'retrying'))
off()
```

| Strategy        | Events                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| circuit breaker | `success`, `failure`, `ignored`, `notPermitted`, `stateChange`, `reset`, `failureRateExceeded`, `slowCallRateExceeded`                     |
| retry           | `retry` (before each wait), `success`, `failure` (every attempt used), `ignored` (not retryable, aborted, or a predicate or backoff threw) |
| time limiter    | `success`, `failure`, `timeout`                                                                                                            |
| bulkhead        | `permitted` (with how long it waited), `rejected`, `finished` (a call gave its slot back)                                                  |
| rate limiter    | `permitted` (with how long it waited), `rejected` (with `retryAfter`)                                                                      |
| fallback        | `recovered`, `failure` (the handler or `fallbackOn` threw), `ignored` (not handled, or the caller aborted)                                 |

Every payload carries the strategy's `name`. Listeners run synchronously. A listener that throws, or returns a
promise that rejects, never changes the outcome of the call; its error is rethrown on the next microtask, where
the runtime reports it as uncaught (in Node, that ends the process by default). Listeners must not throw.

## OpenTelemetry

```sh
npm install @opentelemetry/api
```

```ts
import {
  instrumentBulkhead,
  instrumentCircuitBreaker,
  instrumentFallback,
  instrumentRateLimiter,
  instrumentRetry,
  instrumentTimeLimiter,
} from '@caffeinejs/resilience/otel'

const stopBreaker = instrumentCircuitBreaker(breaker) // global MeterProvider
const stopRetry = instrumentRetry(retries, { meterProvider }) // or a provider of your own
const stop = [
  instrumentTimeLimiter(deadline),
  instrumentBulkhead(pool),
  instrumentRateLimiter(quota),
  instrumentFallback(staleStock),
]

stopBreaker()
stopRetry()
stop.forEach(off => off())
```

Instruments are created under the scope `@caffeinejs/resilience`. Give every instrumented strategy its own `name`.
Two that share one write to the same series: the duration histogram adds them up, and for every observable
instrument the strategy instrumented last replaces the other.

| Metric                                             | Instrument                 | Unit           | Attributes                                                                                                                                          |
| -------------------------------------------------- | -------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resilience.circuit_breaker.call.duration`         | Histogram                  | `s`            | name, `resilience.circuit_breaker.kind` (`successful`, `failed`, `ignored`), `error.type` when failed                                               |
| `resilience.circuit_breaker.not_permitted_calls`   | Observable counter         | `{call}`       | name                                                                                                                                                |
| `resilience.circuit_breaker.state`                 | Observable up-down counter | `1`            | name, `resilience.circuit_breaker.state`: 1 for the current state, 0 for the others                                                                 |
| `resilience.circuit_breaker.buffered_calls`        | Observable up-down counter | `{call}`       | name, kind (`successful`, `failed`)                                                                                                                 |
| `resilience.circuit_breaker.slow_calls`            | Observable up-down counter | `{call}`       | name, kind (`successful`, `failed`)                                                                                                                 |
| `resilience.circuit_breaker.failure_rate`          | Observable gauge           | `1`            | name; 0 to 1, absent below the minimum number of calls                                                                                              |
| `resilience.circuit_breaker.slow_call_rate`        | Observable gauge           | `1`            | name; 0 to 1, absent below the minimum number of calls                                                                                              |
| `resilience.retry.calls`                           | Observable counter         | `{call}`       | `resilience.retry.name`, `resilience.retry.kind` (`successful_without_retry`, `successful_with_retry`, `failed_without_retry`, `failed_with_retry`) |
| `resilience.time_limiter.calls`                    | Observable counter         | `{call}`       | `resilience.time_limiter.name`, `resilience.time_limiter.kind` (`successful`, `failed`, `timeout`)                                                  |
| `resilience.bulkhead.available_concurrent_calls`   | Observable up-down counter | `{call}`       | `resilience.bulkhead.name`                                                                                                                          |
| `resilience.bulkhead.max_allowed_concurrent_calls` | Observable up-down counter | `{call}`       | `resilience.bulkhead.name`                                                                                                                          |
| `resilience.bulkhead.queued_calls`                 | Observable up-down counter | `{call}`       | `resilience.bulkhead.name`                                                                                                                          |
| `resilience.bulkhead.rejected_calls`               | Observable counter         | `{call}`       | `resilience.bulkhead.name`                                                                                                                          |
| `resilience.rate_limiter.available_permissions`    | Observable up-down counter | `{permission}` | `resilience.rate_limiter.name`                                                                                                                      |
| `resilience.rate_limiter.waiting_calls`            | Observable up-down counter | `{call}`       | `resilience.rate_limiter.name`                                                                                                                      |
| `resilience.rate_limiter.rejected_calls`           | Observable counter         | `{call}`       | `resilience.rate_limiter.name`                                                                                                                      |
| `resilience.fallback.calls`                        | Observable counter         | `{call}`       | `resilience.fallback.name`, `resilience.fallback.kind` (`successful`, `recovered`, `failed`, `ignored`)                                             |

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
way cannot reach the operation. This one also aborts the work when the process starts shutting down:

```ts
const untilShutdown: Strategy = (ctx, next) =>
  next(
    ctx.with({ signal: ctx.signal === undefined ? shutdown.signal : AbortSignal.any([ctx.signal, shutdown.signal]) }),
  )
```

For a deadline, use `timeLimiter()`: it also rejects when the operation ignores its signal, links the caller's
signal and leaves no timer or listener behind.

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
