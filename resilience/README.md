# @caffeinejs/resilience

Circuit breaker, retry, time limiter, bulkhead, rate limiter and fallback for any JavaScript runtime, composed as
plain functions. Its one dependency is `@caffeinejs/std`, which has none; every integration is an optional subpath.

```sh
npm install @caffeinejs/resilience
```

| Import from                             | What                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `@caffeinejs/resilience`                | `compose`, `decorate`, `run`, `exponential`, the policy types, shared errors                              |
| `@caffeinejs/resilience/circuitbreaker` | `circuitBreaker`, `ErrCallNotPermitted`                                                                   |
| `@caffeinejs/resilience/retry`          | `retry`, `ErrMaxRetriesExceeded`                                                                          |
| `@caffeinejs/resilience/timelimiter`    | `timeLimiter`, `ErrTimeLimitExceeded`                                                                     |
| `@caffeinejs/resilience/bulkhead`       | `bulkhead`, `ErrBulkheadFull`                                                                             |
| `@caffeinejs/resilience/ratelimiter`    | `rateLimiter`, `ErrRateLimitExceeded`                                                                     |
| `@caffeinejs/resilience/fallback`       | `fallback`                                                                                                |
| `@caffeinejs/resilience/aop`            | Annotations and the `Resilience()` feature, with `@caffeinejs/di` and `@caffeinejs/application` installed |
| `@caffeinejs/resilience/http`           | `ResilienceErrorHandler`, `isClientError`, `ResilienceHTTP()`, with `@caffeinejs/http` installed          |
| `@caffeinejs/resilience/otel`           | OpenTelemetry instruments, with `@opentelemetry/api` installed                                            |

## Quick start

A policy guards an operation: it takes one and returns one that does the same work, guarded. The built-in policies
hold state (a circuit breaker remembers recent calls), so create each one **once** per protected dependency and share
it. A breaker created per call never sees a second call and never opens.

```ts
import { compose, decorate, exponential } from '@caffeinejs/resilience'
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

async function fetchStock(id: string, signal?: AbortSignal): Promise<Stock> {
  const res = await fetch(`https://inventory/stock/${id}`, { signal })
  return (await res.json()) as Stock
}

export const getStock = decorate(compose(retries, breaker), fetchStock)

// per call
const stock = await getStock('42', request.signal) // Promise<Stock>
```

`decorate` keeps the function's signature and builds the chain once. The result is always a promise: a synchronous
throw rejects it.

Every delay, wait and threshold is a `Duration` from `@caffeinejs/std/duration`, a number of milliseconds written
with its constants: `2 * Second`, `500 * Millisecond`.

## Composing policies

`compose(a, b, c)` is one policy made of three, listed from the outermost to the innermost: applied to an operation,
it runs `a(b(c(op)))`. A layer is a built-in instance, which composes through its `wrap()` method, or a function of
your own (see [Writing a policy](#writing-a-policy)); the two mix freely, and a composed policy is a layer too.

```ts
// retry around the breaker: each attempt is one breaker call; an open breaker fails the call at once
compose(retries, breaker)

// breaker around the retry: one breaker call per whole retry sequence
compose(breaker, retries)
```

The first is the usual choice. With every policy, the recommended order, which the annotations use, is:

```ts
const inventory = compose(staleStock, retries, breaker, quota, deadline, pool)
// fallback( retry( circuitBreaker( rateLimiter( timeLimiter( bulkhead( operation ))))))
```

- The fallback answers for the whole call, after every attempt.
- The retry repeats the whole inner chain; an open breaker, a full bulkhead or a spent quota fails the call at once.
- The breaker records each attempt, a timeout included, and never a refusal from inside it.
- The rate limiter counts attempts against the quota.
- The time limiter bounds each attempt, the wait for a bulkhead slot included.
- The bulkhead gives a slot back when the attempt really ends. A call the time limiter gave up on may still be
  running, and keeps its slot until it stops, so the bulkhead counts the work really in flight.

Keep the bulkhead's `maxWaitDuration` below the time limiter's `timeoutDuration`. A call still waiting for a slot when
the limit passes times out, and the breaker counts that timeout against a dependency that may be healthy; refused by
the bulkhead first, the call is ignored by the breaker. The annotations refuse to start otherwise. The other way out
is the bulkhead outside the time limiter, `compose(retries, breaker, quota, pool, deadline)`: the limit then bounds
only the running call, and a call that timed out gives its slot back while its operation may still run.

An annotated method gets one time limiter. For a limit per attempt and a total across every attempt and every wait,
compose two:

```ts
const total = timeLimiter({ name: 'inventory-total', timeoutDuration: 5 * Second })
const inventory = compose(total, retries, breaker, deadline, pool)
```

`compose` asks each instance to wrap the operation when the policy is applied, so apply it once and keep the guarded
operation, or `decorate` a function. One guarded operation is safe to call concurrently: each call has its own
context, and only the policies' state is shared.

## Operations and signals

An operation is `(ctx, input) => Promise<T>`. `ctx.signal` is the caller's signal, or the one a policy such as a time
limiter gave the attempt in its place. `input` is what the caller passed, handed through every policy untouched, so
one chain serves every call:

```ts
import { run } from '@caffeinejs/resilience'

const stockOf = compose(retries, breaker)((ctx, id: string) => fetchStock(id, ctx.signal))
await stockOf({ signal: request.signal }, '42')

// once, with the chain built for this call alone
await run(
  compose(retries, breaker)(ctx => fetchStock('42', ctx.signal)),
  request.signal,
)
```

`decorate(policy, fn)` does that for a function. Its input is the argument list, and the caller's signal is the first
argument that is an `AbortSignal`; the function receives the attempt's signal in its place. A call that passes none
hands the function none, so a time limit cannot tell it to stop. `signalAt` names the parameter instead, and the
function then always receives the attempt's signal there:

```ts
const getStock = decorate(compose(retries, deadline), fetchStock, { signalAt: 1 })

await getStock('42') // fetchStock('42', <the attempt's signal>)
```

`this` is not kept: decorate a bound method, `decorate(policy, client.get.bind(client))`.

- Through `run`, `decorate` and the annotations, an already-aborted signal rejects with its reason without running
  anything. A guarded operation called directly leaves that to its policies.
- An abort during a retry's wait rejects at once with the abort reason; no further attempt runs.
- A failure that settles after the caller aborted is not counted against the dependency, not retried, and not
  answered by a fallback.

Each retry that is waiting holds one `abort` listener on the signal until it wakes. Many calls waiting on one
long-lived signal, such as a server's shutdown signal, trigger Node's `MaxListenersExceededWarning` at 11
listeners. Prefer a signal per request.

## Fallback

The promise settles after the whole chain, with the final error: the last attempt's error after retries, or a
refusal such as `ErrCallNotPermitted`. A fallback answers it with something else, such as a cached value. It widens
the result type, so it sits outermost.

```ts
import { ErrCallRefused } from '@caffeinejs/resilience'
import { fallback } from '@caffeinejs/resilience/fallback'

// module scope; the input of a decorated function is its argument list
const staleStock = fallback((error, input) => cachedStock((input as [string])[0]), {
  name: 'inventory',
  on: [ErrCallRefused], // only calls that certainly never ran
})

export const getStock = decorate(compose(staleStock, retries, breaker, deadline), fetchStock)
// (id: string, signal?: AbortSignal) => Promise<Stock | CachedStock>
```

| Option | Default     | Meaning                                                                   |
| ------ | ----------- | ------------------------------------------------------------------------- |
| `name` | `fallback`  | Names the fallback in events and metrics                                  |
| `on`   | every error | Which errors the handler answers: a predicate, or a list of error classes |

The handler receives the error and the call's input, because a useful fallback needs the call's own data, such as
the id to look up.

- Without `on`, every error is answered, a bug included: a typo that throws `TypeError` on every call returns the
  fallback's value on every call, and looks like an outage that never ends. Leaving `TypeError` out by default would
  be wrong too, since `fetch` rejects with one when the network fails. Narrow `on` to what the fallback is for.
- An error `on` declines passes through unchanged, and the `recovered` event carries the error it replaced, so a log
  listener still sees it.
- On a controller, a client error, such as the 403 a handler throws to refuse a caller, never reaches the fallback;
  see [Client errors](#client-errors).
- Once the caller's signal has aborted, the handler never runs: nobody is waiting for the value.
- A handler that throws, or rejects, rejects the call with what it threw.
- An `on` predicate that returns anything but a boolean rejects the call with `ErrInvalidOption`.

A timeout leaves the outcome unknown: the call may have gone through. Limiting a fallback to `ErrCallRefused`
answers only the calls that never ran, which matters for writes such as payments.

`.catch()` still works for a one-off; `fallback()` adds a shared filter, abort awareness, events and metrics.

`ErrCallRefused.retryAfter` is what an HTTP layer puts in `Retry-After`; see [HTTP](#http).

## Circuit breaker

```ts
const breaker = circuitBreaker({
  name: 'payments',
  slidingWindow: { type: 'time', duration: 30 * Second },
  minimumNumberOfCalls: 20,
  slowCallDurationThreshold: 2 * Second,
  slowCallRateThreshold: 80,
  recordResult: res => res instanceof Response && res.status >= 500,
  ignoreError: [ValidationError],
})
```

| Option                                  | Default                        | Meaning                                                                                                                            |
| --------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                  | required                       | Names the breaker in errors, events and metrics                                                                                    |
| `failureRateThreshold`                  | `50`                           | Failure rate, in percent, at or above which the breaker opens                                                                      |
| `slowCallRateThreshold`                 | `100`                          | Slow-call rate, in percent, at or above which the breaker opens                                                                    |
| `slowCallDurationThreshold`             | `1 * Minute`                   | A call longer than this is slow                                                                                                    |
| `slidingWindow`                         | `{ type: 'count', size: 100 }` | The last `size` calls, or `{ type: 'time', duration }` for the calls of the last `duration`, in whole seconds                      |
| `minimumNumberOfCalls`                  | `100`                          | Calls needed before a rate is computed; capped at a count window's size                                                            |
| `waitDurationInOpenState`               | `1 * Minute`                   | Time spent open; a function of how many times in a row it opened, such as `exponential()`                                          |
| `permittedNumberOfCallsInHalfOpenState` | `10`                           | Trial calls let through while half open                                                                                            |
| `maxWaitDurationInHalfOpenState`        | `0` (forever)                  | Re-opens a half-open breaker whose trial calls never settle                                                                        |
| `automaticTransitionFromOpenToHalfOpen` | `false`                        | Moves to half open when the wait elapses, not on the next call                                                                     |
| `recordError`                           | every error                    | Which errors are failures: a predicate, or a list of error classes; any other error counts as a success                            |
| `ignoreError`                           | none                           | Errors that neither count nor affect the state, as `recordError`; checked first. Refusals from inside and aborted calls always are |
| `recordResult`                          | none                           | Whether a returned value is a failure                                                                                              |
| `captureStackTrace`                     | `false`                        | Whether a refusal's `ErrCallNotPermitted` captures a stack trace                                                                   |
| `clock`                                 | the runtime's                  | Where it reads the time and sets its timer; see [Time in tests](#time-in-tests)                                                    |

A list of error classes matches an instance of any of them, subclasses included.

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
  `metricsOnly()`, left with `reset()` or a transition below. Disabled lets everything through and records nothing;
  metrics-only records and reports but never opens.

An operator who knows more than the window, such as that a deploy of the dependency is under way, moves it by hand:

| Method                       | Moves to                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `transitionToOpen({ for? })` | open, for `for` instead of `waitDurationInOpenState`; it counts as an opening for the next wait's backoff |
| `transitionToHalfOpen()`     | half open, with fresh trial slots                                                                         |
| `transitionToClosed()`       | closed, with an empty window                                                                              |
| `reset()`                    | closed, with an empty window, and emits `reset`                                                           |

A call's outcome counts only for the state it started in: a call that settles after the breaker changed state,
by itself or by hand, is reported in events but not recorded.

`breaker.metrics()` returns a snapshot: `failureRate` and `slowCallRate` in percent (`undefined` below the
minimum number of calls), `bufferedCalls`, `failedCalls`, `successfulCalls`, `slowCalls`, `slowFailedCalls`,
`slowSuccessfulCalls`, and `notPermittedCalls`, which counts every refusal since creation and survives `reset()`.

### Work that is not one operation

A body streamed after the response started fails outside any operation a policy could watch. `acquire()` lets one
call through by hand, or returns the refusal, and the caller settles the permit when the work ends:

```ts
const permit = breaker.acquire()
if (permit instanceof ErrCallNotPermitted) {
  throw permit
}

try {
  const res = await fetch(exportURL, { signal })
  await res.body!.pipeTo(destination, { signal })
  permit.onSuccess()
} catch (error) {
  // a caller who left says nothing about the dependency
  if (signal.aborted) {
    permit.release()
  } else {
    permit.onError(error)
  }
  throw error
}
```

`onSuccess()`, `onResult(result)`, `onError(error)` and `release()` settle it; the first one counts and the rest do
nothing. The call's duration runs from `acquire()`. `onResult` and `onError` classify as a wrapped call's outcome is
classified, and `release()` records nothing and gives a half-open trial slot back.

## Retry

```ts
const retries = retry({
  name: 'payments',
  maxAttempts: 4,
  retryOn: [ProviderUnavailable],
  retryOnResult: res => res instanceof Response && res.status === 503,
  discard: res => (res as Response).body?.cancel(),
  backoff: (attempt, error, result) =>
    result instanceof Response && result.headers.has('retry-after')
      ? Number(result.headers.get('retry-after')) * Second
      : 200 * Millisecond * 2 ** (attempt - 1),
  failAfterMaxAttempts: true,
})
```

| Option                 | Default         | Meaning                                                                                           |
| ---------------------- | --------------- | ------------------------------------------------------------------------------------------------- |
| `name`                 | required        | Names the retry in errors, events and metrics                                                     |
| `maxAttempts`          | `3`             | Attempts in total, the first call included                                                        |
| `backoff`              | `exponential()` | The wait between attempts, or `(attempt, error, result) => Duration`                              |
| `retryOn`              | every error     | Which errors are worth another attempt: `(error, attempt) => boolean`, or a list of error classes |
| `retryOnResult`        | none            | Whether a returned value is worth another attempt                                                 |
| `discard`              | none            | Releases a result it tries again, such as a 503 response's body                                   |
| `failAfterMaxAttempts` | `false`         | Reject with `ErrMaxRetriesExceeded` instead of returning the last retryable value                 |
| `clock`                | the runtime's   | Where it sets the timers it waits on                                                              |

A refusal, any `ErrCallRefused` such as an open breaker's `ErrCallNotPermitted`, is never retried, and neither is a
failure after the caller aborted, whatever `retryOn` returns: a refusal means the operation never ran, and retrying
it at once only adds load to what is already refusing. `retryOn` narrows what is retried; it cannot widen it.

A refusal after an attempt that reached the operation, such as a breaker that opened on the timeout before it, ends
the call with that earlier attempt's outcome instead: its error, or its retryable value as when attempts run out. A
refusal out of a retry therefore still means that no attempt ran.

A 503 response holds its connection until its body is read or cancelled. `discard` runs on each result the retry tries
again, after the `retry` event and before the wait, so the body is released while the retry waits. It never runs on the
result the caller receives, nor on an error. A result it released never reaches the caller: when a later attempt is
refused, or the retry is disposed while the call waits, the call rejects with `ErrMaxRetriesExceeded`, which carries
the result. What `discard` throws or rejects with is dropped: it releases a value nobody holds, so no caller is left to
hear of it.

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

const deadline = timeLimiter({
  name: 'inventory',
  timeoutDuration: 2 * Second,
  discard: res => (res as Response).body?.cancel(),
})

export const getStock = decorate(compose(retries, breaker, deadline), fetchStock)
```

| Option            | Default       | Meaning                                                                        |
| ----------------- | ------------- | ------------------------------------------------------------------------------ |
| `name`            | required      | Names the time limiter in errors, events and metrics                           |
| `timeoutDuration` | required      | How long the rest of the chain may run; finite and greater than `0`            |
| `discard`         | none          | Releases a value that arrives after the call ended, by the limit or the caller |
| `clock`           | the runtime's | Where it reads the time and sets its timer                                     |

The rest of the chain gets a signal of its own, linked to the caller's. When the limit passes, that signal aborts
with an `ErrTimeLimitExceeded` and the call rejects with it at once, even when the operation ignores its signal and
never settles. When the caller aborts first, the call rejects with the caller's reason and no timeout is counted.
The signal stays linked to the caller's after the call settles, so a body the operation streams still learns that
the caller left.

The limit counts from the call: time the operation spends before it returns, such as work before its first
`await`, counts too. A timer cannot interrupt that work, so a call that outruns the limit before it returns times
out as soon as it does. An outcome that arrives after the limit times out even when the timer has not fired yet, as
when the event loop was busy.

A timeout cannot undo work: an operation that ignores its signal keeps running after the call rejected, and a
retried write can overlap the one still in flight. Pass the signal to every I/O call, and make writes idempotent. A
value that arrives after the call ended is dropped; `discard` releases it, such as a response whose body nobody will
read. That value was made under a signal that has already aborted: a body tied to it has already failed, and
`cancel()` on it rejects, which `discard` drops along with anything else it throws or rejects with.

Where it sits decides what it bounds: inside a retry, each attempt; outside it, every attempt and every wait between
them (see [Composing policies](#composing-policies)).

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
| `clock`              | the runtime's        | Where it reads the time and sets the timers of waiting calls         |

A slow dependency can use up every request a process serves before enough calls settle for a breaker to open. A
bulkhead caps the calls in flight: past the cap, a call waits in line, first come first served, for at most
`maxWaitDuration` with at most `maxQueuedCalls` waiting, or is refused with `ErrBulkheadFull`. A waiting call whose
signal aborts leaves the line.

A slot is given back when the rest of the chain settles, never earlier. Inside a time limiter that gave up on a call,
the slot stays taken while the operation is still running: the bulkhead counts work really in flight.

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

| Option               | Default       | Meaning                                                              |
| -------------------- | ------------- | -------------------------------------------------------------------- |
| `name`               | required      | Names the rate limiter in errors, events and metrics                 |
| `limitForPeriod`     | required      | Calls that may start in each period                                  |
| `limitRefreshPeriod` | required      | The length of a period                                               |
| `maxWaitDuration`    | `0`           | How long a call may wait for a permit of a later period; `0` refuses |
| `captureStackTrace`  | `false`       | Whether a refusal's `ErrRateLimitExceeded` captures a stack trace    |
| `clock`              | the runtime's | Where it reads the time and sets its refresh timer                   |

At most `limitForPeriod` calls start in each period, periods counted from when the rate limiter was created. A call
that finds no permit left reserves one of a later period when it would get it within `maxWaitDuration`, and starts
then; calls are served in the order they reserved. Otherwise it is refused with `ErrRateLimitExceeded`, whose
`retryAfter` says when its permit would have come. A waiting call whose signal aborts leaves the line; its permit is
spent, unless it was the last in line, which gives its permit back. No timer runs while nobody waits.

Permits are counted per period reserved: on an event loop too busy to start a waiting call in its period, the call
starts later on the permit it reserved, ahead of any call that arrived after it.

A partner that changes its quota at run time is followed without a restart:

- `changeLimitForPeriod(n)` applies from the next period. The calls already waiting are lined up again under the new
  limit, in their order, and one that would now wait past `maxWaitDuration` is refused.
- `changeMaxWaitDuration(d)` applies to the calls that arrive afterwards.

The limit holds in this process only. Ten replicas that each allow 100 calls a second allow 1,000 between them:
divide a partner's quota by the replica count, or enforce it where the calls leave your network.

`quota.metrics()` reports `availablePermissions`, `waitingCalls` and `rejectedCalls`.

## Backoff

`exponential({ initialDelay = 500 * Millisecond, multiplier = 2, maxDelay = 30 * Second, jitter = 0.5 })` returns
`attempt => delay`: `initialDelay · multiplier^(attempt−1)`, capped at `maxDelay`, then randomized to within
`±jitter` of itself for `jitter` in `[0, 1)` without passing the cap. A delay that reached the cap is spread over
`[maxDelay·(1−jitter), maxDelay]`, so clients that back off for long still wait different times. It fits both
`retry({ backoff })` and `circuitBreaker({ waitDurationInOpenState })`.

## Shutdown

A retry sleeping out a 30-second backoff, or a call queued for a slot, would hold a shutdown until it woke.
`dispose()` ends the waits of one instance:

| Instance        | `dispose()`                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| retry           | Ends every sleeping call at once with its last attempt's outcome, and from then on never waits          |
| bulkhead        | Refuses every queued call with `ErrBulkheadFull`, and from then on refuses a call that would wait       |
| rate limiter    | Refuses every waiting call with `ErrRateLimitExceeded`, and from then on refuses a call that would wait |
| circuit breaker | Cancels the timer of `automaticTransitionFromOpenToHalfOpen` and sets none again                        |

Calls already running keep running, and a call that needs no wait still starts. `[Symbol.dispose]` is an alias, so a
`using` declaration disposes at the end of its block. A time limiter's timer lasts no longer than its limit, and a
fallback holds nothing between calls: neither has `dispose()`. The `Resilience()` feature disposes the instances it
defines when the application shuts down.

## Time in tests

The `clock` option takes `{ now(), setTimeout(callback, delay), clearTimeout(handle) }`. The default reads the
runtime's `performance`, captured when the package loads, so fake timers installed later never move its time. A clock
that reads the globals on every call runs on whatever fake timers are installed:

```ts
import type { Clock } from '@caffeinejs/resilience'

export const fakeTimersClock: Clock = {
  now: () => performance.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const breaker = circuitBreaker({ name: 'inventory', clock: fakeTimersClock })
```

## Annotations

```sh
npm install @caffeinejs/di @caffeinejs/application
```

`@caffeinejs/resilience/aop` applies the policies to methods of the classes the container builds. The `Resilience()`
feature defines presets, one per dependency, each holding at most one policy of each kind under the preset's name,
and weaves them in.

```ts
import { Injectable } from '@caffeinejs/di'
import { ErrCallRefused } from '@caffeinejs/resilience'
import { Fallback, Resilience, Resilient, Retry, TimeLimiter } from '@caffeinejs/resilience/aop'

@Injectable([StockCache])
export class InventoryClient {
  constructor(private readonly cache: StockCache) {}

  @Fallback('cachedStock', { on: [ErrCallRefused] })
  @Resilient('inventory')
  async stock(id: string, signal?: AbortSignal): Promise<Stock> {
    const res = await fetch(`https://inventory/stock/${id}`, { signal })
    if (!res.ok) {
      throw new InventoryUnavailable(res.status)
    }
    return (await res.json()) as Stock
  }

  // the error first, then the original arguments
  async cachedStock(error: unknown, id: string): Promise<Stock> {
    return this.cache.get(id)
  }

  // the retry and the breaker of `inventory`, the same instances `stock` uses, with a longer time limit
  @Resilient('inventory')
  @TimeLimiter('inventory-export')
  async export(signal?: AbortSignal): Promise<Report> { … }

  // one policy of a one-policy preset
  @Retry('ledger')
  async post(entry: Entry): Promise<void> { … }
}

createApplication({ container, config }).install(
  Resilience((r, { config }) =>
    r
      .config(config.resilience)
      .preset('inventory', p =>
        p
          .retry({ maxAttempts: 3 })
          .circuitBreaker({ recordResult: res => res instanceof Response && res.status >= 500 })
          .rateLimiter({ limitForPeriod: 100, limitRefreshPeriod: 1 * Second })
          .timeLimiter({ timeoutDuration: 2 * Second })
          .bulkhead({ maxConcurrentCalls: 20 }),
      )
      .preset('inventory-export', p => p.timeLimiter({ timeoutDuration: 30 * Second }))
      .preset('ledger', p => p.retry({ maxAttempts: 5 })),
  ),
)
```

- **Presets, not options.** `@Resilient('inventory')` runs every policy preset `inventory` defines. A stage
  annotation, `@Retry`, `@CircuitBreaker`, `@RateLimiter`, `@TimeLimiter` or `@Bulkhead`, takes one policy of the
  preset it names, and next to `@Resilient` replaces that one policy and keeps the rest. Every method naming a preset
  shares its instances, and so their state, in that container; two applications never share one. A variant such as
  `inventory-export` above keeps one breaker per dependency on purpose: a full preset of its own would split the
  dependency's failures across two breakers, and neither might open.
- **One order.** Whatever order the decorators, or a preset's builder calls, are written in, a method runs
  `fallback(retry(circuitBreaker(rateLimiter(timeLimiter(bulkhead(method))))))`, any subset keeping that order, as
  [Composing policies](#composing-policies) explains. `r.order([...])` sets another order for the whole application,
  outermost first, each of `retry`, `circuitBreaker`, `rateLimiter`, `timeLimiter` and `bulkhead` once; the
  fallback stays outermost. The usual reason is one breaker call per whole retry sequence:
  `r.order(['circuitBreaker', 'retry', 'rateLimiter', 'timeLimiter', 'bulkhead'])`.
- **Methods returning a promise only.** On a synchronous method or a field, the decorators are a type error.
- **On a class.** `@Resilient` and the stage annotations also go on a class, and reach every method it declares or
  inherits with `async`, except one a `@Fallback` names. A method that returns a promise without `async` is not
  reached, because nothing at run time says it returns one: mark it `async` or annotate it. A public `async` helper
  is reached too, and a transport's replay check covers only the entrypoint methods it serves, such as a
  controller's routes: give a helper that writes `@Retry(false)`. A method's own annotations win, kind by kind, and
  at each level a stage annotation wins over `@Resilient`.
- **`false` takes one away.** `@Retry(false)`, `@CircuitBreaker(false)` and the others remove the policy `@Resilient`
  or the class would give one method; `@Resilient(false)` keeps the class's preset off it, while the class's stage
  annotations still reach it.

```ts
@Resilient('inventory')
@Injectable()
export class InventoryClient {
  async stock(id: string): Promise<Stock> { … } // every policy of inventory

  @Retry(false)
  async reserve(id: string): Promise<void> { … } // inventory without its retry

  refresh(): Promise<void> { … } // not async: not reached
}
```

- **Defaults.** `r.defaults(p => ...)` takes the builder a preset does and sets the options every policy of a kind
  starts from. A default shapes a policy a preset defines and never adds one. Lowest first, an option comes from the
  built-in default, the configuration's `defaults`, `r.defaults(...)`, the configured preset, then the preset in code.

```ts
r.defaults(p =>
  p
    .retry({ maxAttempts: 3, backoff: exponential({ initialDelay: 200 * Millisecond }) })
    .circuitBreaker({ waitDurationInOpenState: 30 * Second }),
)
  .preset('inventory', p => p.retry().circuitBreaker()) // 3 attempts from 200ms, open for 30s
  .preset('ledger', p => p.retry({ maxAttempts: 5 })) // 5 attempts, the same backoff, no breaker
```

- **`@Fallback(method)`** names a method of the same class that takes the error, then the original arguments, and
  resolves to what the decorated method does; anything else is a type error. `on` takes a predicate or a list of
  error classes. It never runs once the caller's signal has aborted.
- **The signal argument.** The first argument that is an `AbortSignal` is the caller's signal. With a time limiter,
  each attempt receives one of its own in its place, which the limiter aborts at its limit. A caller that passes none
  still gets the limit, but the method is never told.
- **What is woven.** Every class the container builds: decorated with `@Injectable`, bound by hand, in any scope,
  and subclasses, which inherit the annotations of the methods they do not redeclare. A call through `this` goes
  through the policies too. An instance built with `new`, and a value or a factory bound without a class, is not
  woven.
- **Other aspects.** Aspects run outermost first by ascending order, and the resilience aspect's order is `0`. It
  wraps every aspect with a positive order or none, so a retry runs a transaction aspect once per attempt. An aspect
  with a negative order wraps the whole call instead. An aspect with order `0` ties with it, and the order they were
  registered in decides which runs outside: give such an aspect a non-zero order rather than rely on it.
- **Start-up checks.** `bootstrap()` fails with `ErrInvalidOption` when code defines a preset, the defaults or one of
  their policies twice, a preset defines no policy, a method names a preset nothing defines or a policy its preset
  lacks, a `@Fallback` names a method its class lacks, an annotation is on a static or a private method, a policy's
  options are out of range, a request entrypoint such as a controller carries a retry, a circuit breaker or a
  fallback with no transport integration installed, `r.health(...)` is called twice or its `critical` names a breaker
  it cannot watch, the order does not list each kind once, or a bulkhead or rate limiter inside a method's time
  limiter may wait as long as its limit.

```text
ErrInvalidOption: Cannot weave "LedgerClient.post": preset "ledger" defines no time limiter
Possible Solutions:
  - Add one with r.preset('ledger', p => p.timeLimiter({ ... }))
  - Name a preset that defines one in @TimeLimiter(...)
```

- **Shutdown.** The instances are disposed when the application shuts down; see [Shutdown](#shutdown).

`Resilience()` binds a `ResilienceRegistry`: inject it to use the same instances by hand, or to instrument them,
`registry.retry('inventory')` being the retry of preset `inventory`,
fallbacks included (`registry.fallbacks()`, one per method, named `Class.method`). Its `dispose()` disposes every
instance it holds.

### The attempt context

A method with a time limiter receives each attempt's signal in place of its own `AbortSignal` argument, which it
must then pass to every call below it. An injected `ResilienceContext` hands that signal, and the attempt's number,
to code anywhere below the method instead. Each attempt runs in a frame of its own on the container's
[execution context](../di/README.md#execution-context), extending the caller's:

```ts
import { ResilienceContext } from '@caffeinejs/resilience/aop'

Resilience(r => r.preset('inventory', p => p.retry({ maxAttempts: 3 }).timeLimiter({ timeoutDuration: 2 * Second })))

@Injectable([InventoryHTTP])
class InventoryClient {
  constructor(private readonly http: InventoryHTTP) {}

  @Resilient('inventory')
  async stock(id: string): Promise<Stock> {
    return this.http.get(`/stock/${id}`) // no signal parameter
  }
}

@Injectable([ResilienceContext])
class InventoryHTTP {
  constructor(private readonly attempt: ResilienceContext) {}

  async get<T>(path: string): Promise<T> {
    const res = await fetch(base + path, {
      signal: this.attempt.signal, // aborts at 2s, attempt by attempt
      headers: { 'x-attempt': String(this.attempt.attempt) }, // 1, 2, 3
    })
    return (await res.json()) as T
  }
}
```

- Inside nested annotated methods, the innermost attempt is the one read. An inner method that takes no signal runs
  under the outer attempt's, so the outer deadline still reaches the code below it. Outside every attempt, `signal`
  and `attempt` are `undefined`, so the same class works when called directly.
- Attempts are kept on the container's `contextStorage`, the one the request scope and the HTTP adapter use, so code
  below an annotated method still sees the request it runs in. Give the container a storage of your own with
  `container.bindContextStorage(...)`.
- Where the container has no context storage, `ResilienceContext` is still bound, and reading it throws
  `ErrInvalidOption`. The method's own signal argument works either way.

### Health

`r.health(...)` reports every circuit breaker to the readiness probe, as one health indicator named `resilience`.
Without it, no indicator is bound.

```ts
Resilience(r =>
  r
    .preset('payments', p => p.retry().circuitBreaker({ automaticTransitionFromOpenToHalfOpen: true }))
    .preset('recommendations', p => p.circuitBreaker())
    .health({ critical: ['payments'] }),
)
```

| Breakers               | Indicator                                                | Readiness |
| ---------------------- | -------------------------------------------------------- | --------- |
| all closed             | `up`                                                     | passes    |
| `recommendations` open | `degraded`, data `{ open: { recommendations: 'open' } }` | passes    |
| `payments` half open   | `degraded`, data `{ open: { payments: 'half_open' } }`   | passes    |
| `payments` open        | `down`, data `{ open: { payments: 'open' } }`            | fails     |

- **Nothing is critical by default.** A breaker usually guards a dependency every replica shares: failing readiness
  on it takes the whole service out of the load balancer at once.
- **Half open passes.** Its trial calls are what close the breaker, and a failing probe would keep them away.
- **A critical breaker moves on by itself.** It must set `automaticTransitionFromOpenToHalfOpen: true`, or start-up
  fails: while readiness fails, no call comes to move it out of the open state.
- A name in `critical` that no preset's circuit breaker has fails start-up.

### Configuration

A preset is defined in code, in the configuration tree, or both. Code wins, option by option, configuration may add
a policy code left out, `defaults` fills what both leave open, and `r.order(...)` wins over `order`. The application declares the block in its own schema, a
record of presets by name, each holding the data options of its policies:

```ts
export const ConfigSchema = $t.Object({
  resilience: $t.Object(
    {
      order: $t.Optional($t.List($t.UnionEnum(['retry', 'circuitBreaker', 'rateLimiter', 'timeLimiter', 'bulkhead']))),
      presets: $t.Record(
        $t.String(),
        $t.Object({
          retry: $t.Optional($t.Object({ maxAttempts: $t.Optional($t.Integer()) })),
          timeLimiter: $t.Optional($t.Object({ timeoutDuration: $t.Optional($t.Duration()) })),
        }),
        { default: {} },
      ),
    },
    { default: {} },
  ),
})
```

```sh
APP_RESILIENCE__PRESETS__INVENTORY__RETRY__MAX_ATTEMPTS=5
APP_RESILIENCE__PRESETS__INVENTORY__TIME_LIMITER__TIMEOUT_DURATION=1500ms
APP_RESILIENCE__DEFAULTS__RETRY__MAX_ATTEMPTS=4
APP_RESILIENCE__ORDER=circuitBreaker,retry,rateLimiter,timeLimiter,bulkhead
```

Durations are text with a unit: a bare `1500` fails validation at `bootstrap()`.

A retry's backoff is an object, never a bare duration: `{ type: 'exponential' }` with any of `initialDelay`,
`multiplier`, `maxDelay` and `jitter`, each defaulted as `exponential()` defaults it, or `{ type: 'fixed', delay }`
for a wait that never changes. A backoff code sets replaces the configured one whole.

```sh
APP_RESILIENCE__PRESETS__INVENTORY__RETRY__BACKOFF__TYPE=exponential
APP_RESILIENCE__PRESETS__INVENTORY__RETRY__BACKOFF__INITIAL_DELAY=200ms
APP_RESILIENCE__PRESETS__LEDGER__RETRY__BACKOFF__TYPE=fixed
APP_RESILIENCE__PRESETS__LEDGER__RETRY__BACKOFF__DELAY=1s
```

## HTTP

```sh
npm install @caffeinejs/http
```

`@caffeinejs/resilience/http` answers resilience errors over HTTP and checks, at start-up, which handlers may be
retried.

```ts
import { Resilience } from '@caffeinejs/resilience/aop'
import { ResilienceErrorHandler, ResilienceHTTP } from '@caffeinejs/resilience/http'

createWebApplication({ container, config })
  .install(Resilience(r => r.preset('feed', p => p.retry({ maxAttempts: 3 }))))
  .install(ResilienceHTTP())
  .errorHandling(e => e.globalHandlers(ResilienceErrorHandler))
```

`ResilienceErrorHandler` answers with an RFC 9457 problem, its title and detail the status phrase, so breaker and
dependency names never reach a client:

| Error                  | Status | `Retry-After`                                |
| ---------------------- | ------ | -------------------------------------------- |
| `ErrCallNotPermitted`  | 503    | whole seconds, rounded up, when it is `open` |
| `ErrRateLimitExceeded` | 503    | whole seconds, rounded up                    |
| `ErrBulkheadFull`      | 503    | none                                         |
| `ErrTimeLimitExceeded` | 504    | none                                         |

A rate limiter on a route answers 503, not 429: it limits the whole process, not one client. Any other error is
left to the application's handlers.

### Client errors

A 4xx answer a handler throws is the client's own, not a failing dependency. On every call of a controller method,
`ResilienceHTTP()` tells the policies which errors those are, with `isClientError`: such an error is never retried, a
circuit breaker records it as ignored, and a fallback never answers it. A burst of requests for missing records cannot
open the breaker for every client, and a fallback that serves cached orders cannot answer a 403 with the order it
refused. No option turns this off: a handler that wants to answer a client error itself, such as a 404 turned into an
empty list, catches it in the handler. `Resilience()` refuses to start when a controller carries a retry, a circuit
breaker or a fallback and `ResilienceHTTP()` is not installed, since nothing would tell those policies which errors
are the client's.

An `ErrHTTP` with a 4xx status, such as `ErrHTTPNotFound`, is a client error. Any other error is one when it carries a
numeric `status` or `statusCode` from 400 to 499, except 408 and 429: a dependency that timed out or throttled is
failing for now. The breaker counts an ignored error neither as a failure nor as a success.

Only the controller's own calls are classified. A service or an outbound client the handler calls keeps retrying and
counting every error, even under the same preset, since a 404 from a dependency may be its failure. Where one should
not blame the dependency for a client's mistake either, pass `isClientError` to its policies:

```ts
import { isClientError } from '@caffeinejs/resilience/http'

Resilience(r =>
  r.preset('catalog', p =>
    p.retry({ maxAttempts: 3, retryOn: error => !isClientError(error) }).circuitBreaker({ ignoreError: isClientError }),
  ),
)

@Fallback('cachedItem', { on: error => !isClientError(error) })
```

Resilience annotations work on controller methods as on any other: a controller is a class the container builds.
A retry on a handler, from `@Retry` or from the preset `@Resilient` names, runs the whole handler again, every service
it calls, every write and every outbound request included:

1. **Side effects run again.** A `POST /orders` that wrote the order, then failed, writes a second one.
2. **Attempts overlap after a timeout.** A time limiter gives up on an attempt the dependency may still be running;
   the next attempt can overlap it. Aborting the signal stops only work that listens to it.
3. **A body read as a stream is gone.** The second attempt reads nothing.
4. **A response already sent** cannot be replaced by a second attempt or a fallback.

`ResilienceHTTP()` refuses, at `bootstrap()`, a retry on a handler routed for any method that is not safe, and on any
route that reads its body as a stream. The safe methods are `SAFE_METHODS` from `@caffeinejs/http`: `GET`, `HEAD`,
`OPTIONS` and `TRACE` (RFC 9110), and `QUERY`, the same list the cross-site request check exempts. `PUT` and `DELETE`
are idempotent but not safe: idempotence promises only the final state of the resource, while a replayed handler repeats
everything else it does, and after a timeout two attempts can run at once.

```text
ErrInvalidOption: Cannot retry "POST /orders" (OrdersController.place): POST is not a retryable method
```

There are three ways out, narrowest first:

```ts
// 1. The handler declares that running it twice is safe, such as an upsert by a client-sent Idempotency-Key.
//    This permits the replay; it deduplicates nothing. @Resilient('orders', { repeatable: true }) says the same.
@Retry('orders', { repeatable: true })
@Post('/', p => [p.header('idempotency-key'), p.body()])
async place(key: string, order: NewOrder): Promise<Order> { … }

// 2. Every handler of a method is safe to replay: here, every PUT and DELETE handler of the application.
//    SAFE_METHODS comes from @caffeinejs/http; retryableMethods(...) replaces the default, it does not add to it.
.install(ResilienceHTTP(h => h.retryableMethods(...SAFE_METHODS, 'PUT', 'DELETE')))

// 3. From configuration, code winning: RESILIENCE_HTTP__RETRYABLE_METHODS=GET,HEAD,OPTIONS,TRACE,QUERY,PUT
.install(ResilienceHTTP((h, { config }) => h.config(config.resilienceHttp)))
```

The better answer is usually none of them: put `@Retry` on the outbound client method the handler calls, where the
repeated unit is one dependency call. A service's `@Retry` is never checked, and neither is one on a controller method
that is not a route handler: a helper the handler calls through `this` is woven, so its writes replay unchecked; keep
`@Retry` on the outbound client method. `Resilience()` refuses to start when a controller carries a retry, a circuit
breaker or a fallback and `ResilienceHTTP()` is not installed; see [Client errors](#client-errors) and
[Writing a transport integration](#writing-a-transport-integration). Nothing checks that a response was already sent
before a retry or a fallback (hazard 4): keep handler retries for handlers that answer only by returning.

### Writing a transport integration

`ResilienceHTTP()` is the integration for HTTP; another transport, such as gRPC or GraphQL, would ship its own, built
on the same seam. It has four duties:

1. **Claim its entrypoints.** The transport labels every class whose methods it calls on a request with
   `kEntrypoint`, as `@Controller` does, beside a label of its own. The integration binds a `ResilienceTransport` that
   names that label. `Resilience()` refuses an entrypoint with a retry, a circuit breaker or a fallback whose labels
   no installed transport claims.
2. **Check replays.** At `bootstrap()`, it resolves each entrypoint method with `stagesOf(cls, method, registry)`,
   which sees a retry from `@Retry`, `@Resilient` and the class alike, and refuses the ones it cannot replay, unless
   the annotation that gives the method its retry declares it `repeatable`.
3. **Map failures.** `failureOf(error)` from the root entry classifies a refusal as `unavailable`, with its
   `retryAfter`, and a time limit as `timeout`; anything else is `undefined`, left to the transport's own handlers.
   HTTP answers 503 and 504; gRPC would answer `UNAVAILABLE` and `DEADLINE_EXCEEDED`.
4. **Tell client errors apart.** `isClientError(error)` on the transport says which errors an entrypoint method
   throws as its client's own answer. On every call of a class the transport claims, those pass the policies untouched:
   not retried, ignored by the breaker, never answered by a fallback. HTTP's is `isClientError`; gRPC's would pick
   status codes such as `NOT_FOUND` and `INVALID_ARGUMENT`.

```ts
// kGRPCService, isIdempotent and isGRPCClientError are the gRPC package's own
class GRPCTransport extends ResilienceTransport {
  readonly label = kGRPCService

  isClientError(error: unknown): boolean {
    return isGRPCClientError(error)
  }
}

class ResilienceGRPCBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'resilience-grpc'

  protected override configure(kit: FeatureConfigureKit<C>): void {
    kit.container.bind(GRPCTransport, t => t.toSelf().extends(ResilienceTransport))
  }

  protected override bootstrap(kit: BootstrapKit<C>): void {
    const registry = kit.container.get(ResilienceRegistry)
    for (const { binding } of kit.container.getBindingsByLabel(kGRPCService)) {
      for (const method of wovenMembers(binding.type)) {
        const { stages, repeatable } = stagesOf(binding.type, method, registry)
        if (stages.retry !== undefined && !repeatable && !isIdempotent(binding.type, method)) {
          throw new ErrInvalidOption(/* the gRPC replay rule */)
        }
      }
    }
  }
}
```

## Errors

| Error                   | From              | `code`                     | When                                                                                                                                             |
| ----------------------- | ----------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ErrCallNotPermitted`   | `/circuitbreaker` | `ERR_CALL_NOT_PERMITTED`   | A breaker refused the call. `breaker`, `state`, and `retryAfter` when `state` is `open`                                                          |
| `ErrBulkheadFull`       | `/bulkhead`       | `ERR_BULKHEAD_FULL`        | No slot, and no room or time to wait for one. `bulkhead`                                                                                         |
| `ErrRateLimitExceeded`  | `/ratelimiter`    | `ERR_RATE_LIMIT_EXCEEDED`  | No permit within `maxWaitDuration`. `rateLimiter`, `retryAfter`                                                                                  |
| `ErrTimeLimitExceeded`  | `/timelimiter`    | `ERR_TIME_LIMIT_EXCEEDED`  | The rest of the chain ran past the limit. `timeLimiter`, `timeoutDuration`                                                                       |
| `ErrMaxRetriesExceeded` | `/retry`          | `ERR_MAX_RETRIES_EXCEEDED` | `failAfterMaxAttempts` and the last value was still retryable. `attempts`, `result`                                                              |
| `ErrInvalidOption`      | root              | `ERR_INVALID_OPTION`       | A bad option, argument, name or annotation, when created, at `bootstrap()` or on a call; or a computed delay or a predicate's answer is unusable |

All extend `ErrResilience`. A refusal, a call a policy turned away without running it, extends `ErrCallRefused`,
which carries `retryAfter` when the policy knows how long to wait: catch `ErrCallRefused` to handle every kind of
refusal at once. `ErrCallNotPermitted`, `ErrBulkheadFull` and `ErrRateLimitExceeded` are refusals;
`ErrTimeLimitExceeded` is not, because the operation ran.

Refusals carry no stack trace by default: they arrive in bulk while a dependency is down, capturing a stack costs
several times the rest of the refusal, and their fields already say why the call failed. Such a refusal is built
without running its constructor: `instanceof`, `message`, `code` and every field work, and `stack` is its first line,
but `Error.isError()` and Node's `util.types.isNativeError()` answer `false`. Pass `captureStackTrace: true` to the
policy for a stack trace, or where a logger or a serializer relies on those checks.

## Events

```ts
const off = breaker.on('stateChange', e => log.warn({ breaker: e.name, from: e.from, to: e.to }, 'circuit breaker'))
retries.on('retry', e => log.info({ retry: e.name, attempt: e.attempt, delayMs: e.delay }, 'retrying'))
off()
```

| Policy          | Events                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| circuit breaker | `success`, `failure`, `ignored`, `notPermitted`, `stateChange`, `reset`, `failureRateExceeded`, `slowCallRateExceeded`                               |
| retry           | `retry` (before each wait), `success`, `failure` (every attempt used), `ignored` (not retryable, aborted, disposed, or a predicate or backoff threw) |
| time limiter    | `success`, `failure`, `timeout`                                                                                                                      |
| bulkhead        | `permitted` (with how long it waited), `rejected`, `finished` (a call gave its slot back)                                                            |
| rate limiter    | `permitted` (with how long it waited), `rejected` (with `retryAfter`)                                                                                |
| fallback        | `recovered`, `failure` (the handler or `on` threw), `ignored` (not handled, or the caller aborted)                                                   |

Every payload carries the policy's `name`. With the annotations, `registry.on(listener)` hands one listener every
event of every instance the `ResilienceRegistry` holds, fallbacks included, each tagged with its `kind`, `type` and
`name`, and returns the function that removes it:

```ts
const off = registry.on(({ kind, type, name, event }) => {
  if (type === 'stateChange' || type === 'rejected') {
    log.warn({ kind, name, event }, 'resilience')
  }
})
```

Listeners run synchronously. A listener that throws, or returns a
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

With the annotations, `instrumentRegistry(registry, options?)` instruments every instance the
`ResilienceRegistry` holds, fallbacks included, and returns one function that stops them all. Call it once the
application has started: a fallback joins the registry when its class is checked at start-up.

```ts
import { instrumentRegistry } from '@caffeinejs/resilience/otel'

await app.bootstrap()
const stop = instrumentRegistry(app.container.get(ResilienceRegistry))
```

Instruments are created under the scope `@caffeinejs/resilience`. Give every instrumented policy its own `name`.
Two that share one write to the same series: the duration histogram adds them up, and for every observable
instrument the policy instrumented last replaces the other.

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

## Writing a policy

A policy is a function from an operation to an operation. One of your own composes with the built-ins:

```ts
import type { Policy } from '@caffeinejs/resilience'

const timing: Policy = op => async (ctx, input) => {
  const start = performance.now()
  try {
    return await op(ctx, input)
  } finally {
    histogram.record(performance.now() - start)
  }
}

compose(retries, timing, breaker) // times each attempt, inside the retry
```

Through `compose` and `decorate`, the operation a policy receives always returns a promise and never throws
synchronously, whatever the layers inside it do, so chaining `.then()` or `.finally()` on it is safe. What a policy
returns is guarded the same way: a synchronous throw from it rejects the call, so the layers outside it always settle
what they started.

To hand the rest of the chain a different signal, call it with a new context that keeps the other fields of the one
it got, such as `isClientError`. This one also aborts the work when the process starts shutting down:

```ts
const untilShutdown: Policy = op => (ctx, input) =>
  op(
    { ...ctx, signal: ctx.signal === undefined ? shutdown.signal : AbortSignal.any([ctx.signal, shutdown.signal]) },
    input,
  )
```

For a deadline, use `timeLimiter()`: it also rejects when the operation ignores its signal, links the caller's
signal and leaves no timer or listener behind.

A policy with state is a class with a `wrap()` method, which `compose` and `decorate` call once, when the chain is
built:

```ts
import type { Operation, Wrapper } from '@caffeinejs/resilience'

class Counting implements Wrapper {
  calls = 0

  wrap<T, I = void>(op: Operation<T, I>): Operation<T, I> {
    return (ctx, input) => {
      this.calls++
      return op(ctx, input)
    }
  }
}
```
