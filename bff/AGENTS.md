# `@caffeinejs/bff`

Functional helpers for composing the calls a screen makes. Follow the root [`AGENTS.md`](../AGENTS.md).

## A call is a function of a signal

`Call<T>` is `(signal: AbortSignal) => Promise<T>`. `timeout` and `map` take a call and return a call. `required` and `optional` tag a call. `join` runs tagged calls and nothing else.

A new behaviour is another function of that shape. `join` does not gain methods, and there is no list of plugins for it to interpret.

`map` and `timeout` sit inside the tag. Past the tag, a failure is either the join's rejection or an arm's reason, and a combinator no longer sees the value.

## `timeout`

A number is milliseconds. A string is a `Duration`, converted with `toMillis` from `@caffeinejs/std` (`parseDuration` returns seconds). `timeout(1)` is 1ms.

A string that fails `DURATION_PATTERN`, or a number that is not finite and greater than 0, throws `ErrBFFInvalidTimeout` when `timeout(...)` is called. `parseDuration('nope')` is `0`, and a 0ms timer would abort every call.

The timer is not unref'd. It is what settles a call that ignores the signal, and it is cleared when the call settles. The child signal aborts with the caller's reason when that signal aborts, and with `ErrBFFTimeout` when the timer fires.

## `join`

The first argument is `{ readonly signal: AbortSignal }`. A handler passes `ctx`. The package does not depend on `@caffeinejs/http`.

One controller, aborted when that signal aborts. Every arm receives it. A required failure aborts it and rejects `join` with the original error. There is no partial screen.

An optional `ErrBFFTimeout` is `{ ok: false, reason: 'timeout' }`. Any other optional rejection is `{ ok: false, reason: 'unavailable' }`. The error object is not on the arm.

The caller's signal aborting rejects `join`. It is not an optional reason.

## Resilience

Production code does not import `@caffeinejs/resilience`. A call can be `signal => runWith(op, breaker, signal)` because a call is already a function of a signal. Tests are the place that imports the package.
