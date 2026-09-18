# `@caffeinejs/resilience`

Follow the root [`AGENTS.md`](../AGENTS.md). The rules below are specific to this package.

## Runtime-agnostic, and the compiler proves it

`tsconfig.build.json` compiles with `"types": []` and `"lib": ["esnext", "dom"]`: `process`, `Buffer` and `node:*`
do not exist here, and a build that needs them fails. Time is `clock.now()` from `timers.ts`: the `performance`
object captured once at load, because Node's `globalThis.performance` is a getter that costs about 14 ns a read.
Fake timers replace the global and miss the captured object, so tests that fake time call `useFakeClock()` from
`fake_clock.testkit.ts`. `Date.now()` is never used. `otel/` is the only directory that imports a dependency
(`@opentelemetry/api`, an optional peer) and it is not reachable from `index.ts`.

## The hot path allocates nothing it does not need

A call through a `compose()` runner allocates one context object and the promises. Rules the hot path keeps:

- A strategy's `run` is not `async`: it returns `next(ctx).then(...)`. The entry, and the link `compose.ts` builds
  around every later strategy, turn a synchronous throw or a non-promise into a promise, so the `next` a strategy
  receives never throws. A built-in also calls `next` inside its own `try` and wraps a plain value with `settled`:
  `run` is public and may be called by hand with any `next`, and a taken permit or a counted attempt must still be
  settled. Only a retry that has to wait enters an `async` function; an `async` strategy would also add an `async`
  frame to every error thrown after an `await`.
- A refusal is returned as `Promise.reject(...)`, never thrown, and captures no stack unless the breaker was
  created with `captureStackTrace: true`. `Error.stackTraceLimit` is restored in a `finally`. The error is built in
  `run`, the frame that refuses; `#admit` only says why.
- Chains call object strategies as methods; nothing is bound per chain or per call.
- Windows are typed arrays with O(1) record; thresholds compare in integer form
  (`failed * 100 >= threshold * total`) and rates are divided out only when the breaker opens.
- An event object is built only when `emitter.has(type)`, which returns at once while nothing listens.

`runWith()` pays the chain build per call and `compose()` once. Measure with `make bench:resilience`, alone on the
machine, before and after touching `compose.ts`, `circuit_breaker.ts` or `retry.ts`.

## Every frame of ours is one of the caller's

An error keeps `Error.stackTraceLimit` frames, 10 by default in Node, so each frame the chain puts between the
caller and the operation is one of the caller's that the trace loses. The entry (the `compose()` runner or
`runWith`) calls the first strategy itself, every later strategy adds its link and its `run`, and `Context.invoke`
calls the operation: 2n + 1 frames for n strategies. Nothing else calls `next` or a strategy: no helper and no
`bind`, and a `try` that must catch a strategy's throw sits in the frame that calls it. The frame-budget tests in
`compose.test.ts` and `circuit_breaker.test.ts` fail when a frame is added.

## State generations decide what a late result means

Every state entry increments a generation; a call captures it when permitted. A result whose generation no
longer matches is not recorded and releases no permit, but its `success`/`failure`/`ignored` event still emits.
Every transition finishes mutating before it emits, so listeners may call `reset()` reentrantly.

## Timers

Every delay passes through `clampDelay` (`[0, 2_147_483_647]`, non-finite → `ErrInvalidOption`). The breaker's
auto-transition timer is `unref`'d when the runtime allows; a retry sleep is not, because a pending retry is
pending work. A sleep removes its `abort` listener when it wakes.

## Documentation

TSDoc and the README name no third-party resilience library. OpenTelemetry and Prometheus may be named.
