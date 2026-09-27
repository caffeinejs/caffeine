# `@caffeinejs/resilience`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

## Runtime-agnostic

- `process`, `Buffer` and `node:*` do not exist here.
- Time is `clock.now()` from `timers.ts`, never `Date.now()`.
- A test that fakes time calls `useFakeClock()` from `fake_clock.testkit.ts`; fake timers alone miss the captured
  `performance`.
- Only `otel/` imports a dependency (`@opentelemetry/api`, an optional peer), and `index.ts` does not reach it.

## Hot path

- A strategy's `run` is not `async`: it returns `next(ctx).then(...)`. A built-in still calls `next` inside its own
  `try` and wraps a plain value with `settled`, because `run` is public and may be called by hand with any `next`.
  A waiting retry settles the caller's promise from its own handlers, never from an `async` function.
- A refusal is returned as `Promise.reject(...)`, never thrown, and captures no stack unless the breaker was created
  with `captureStackTrace: true`; `Error.stackTraceLimit` is restored in a `finally`.
- Chains call object strategies as methods; nothing is bound per chain or per call.
- Windows are typed arrays and record in O(1). Thresholds compare without division
  (`failed * 100 >= threshold * total`); a rate is divided out only when the breaker opens or, in `metrics_only`,
  when one crosses its threshold.
- An event object is built only when `emitter.has(type)`.
- Nothing else calls `next` or a strategy — no helper, no `bind` — and a `try` that must catch a strategy's throw
  sits in the frame that calls it; the frame-budget tests in `compose.test.ts` and
  `circuit_breaker/circuit_breaker.test.ts` fail when a frame is added.
- Measure with `make bench:resilience`, alone on the machine, before and after touching `compose.ts`,
  `circuit_breaker/circuit_breaker.ts` or `retry/retry.ts`.

## Timers

- Every transition finishes mutating before it emits, so listeners may call `reset()` reentrantly.
- Every delay passes through `clampDelay` (`[0, 2_147_483_647]`, non-finite → `ErrInvalidOption`).
- The breaker's auto-transition timer is `unref`'d when the runtime allows; a retry sleep is not, because a pending
  retry is pending work.
- A sleep removes its `abort` listener when it wakes.

## Documentation

- TSDoc and the README name no third-party resilience library. OpenTelemetry and Prometheus may be named.
