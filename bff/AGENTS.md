# `@caffeinejs/bff`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

- A new behaviour is another function of the `Call<T>` shape. `join` gains no methods, and there is no list of
  plugins for it to interpret.
- A `timeout` string converts with `toMillis` from `@caffeinejs/std/duration`, never `parseDuration`, which
  returns seconds.
- The `timeout` timer is deliberately not unref'd: it is what settles a call that ignores the signal.
- The package does not depend on `@caffeinejs/http`; `join` takes `{ readonly signal: AbortSignal }` and a
  handler passes `ctx`.
- There is no partial screen: a required failure rejects `join`.
- Production code never imports `@caffeinejs/resilience`; tests are the place that imports it.
