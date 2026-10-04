# `@caffeinejs/caching`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

## Wiring

- `HTTPCaching(...)` is an `HTTPPluginFactory`, not a `Feature`, and binds nothing. A `store`, `etagGenerator`
  or `observer` token that resolves to nothing throws `ErrConfiguration`.
- A class-shaped token for a function type (`etagGenerator`) is not supported.
- Do not make `lru-cache` a dependency: a nested copy fails the `options instanceof LRUCache` check in
  `MemoryHTTPCacheStore`.

## Hooks and ordering

- Hooks attach per route from `onRoute` in `cachePlugin()`, never as a server hook
  (`http/_tests/route_hooks_zero_cost.test.ts`).
- `cachePlugin()` is handed resolved `CacheDeps` and never reads the container.
- The store and eviction hooks hand back a promise only around a store call. Do not make them `async`: Fastify
  would send twice after its `handlerTimeout` 503 (`http/_tests/signals.test.ts`).
- Cache hooks run behind `@UseGuards`. A cached response that skipped authorization is a bypass.

## Responses and keys

- A request is private when the route says so, when it carries `Authorization`, or when
  `request.user.authenticated`. Do not narrow this back to the header: a cookie-authenticated response in a
  shared store is a leak.
- Never compare `If-Modified-Since` with a `Last-Modified` the cache stamped itself.
- What goes out in `Cache-Control` is floored, never rounded.
- `buildCacheKey` in `_util.ts` is the one key derivation. Nothing else rebuilds a key.
- Eviction is by tag only. Do not add eviction by path or by key.
- Never build a `FastifyContextRequest` in this package; a `key` function gets `request.httpContext.req`.

## Store calls

- Every store call goes through `withStoreSignal` (`store_signal.ts`). Keep the timer cleared on settle.
- `HTTPCacheStore` has three verbs, `get`, `put` and `evictByTag`. Do not add a delete, a batch, a lock or a
  wait verb.
- The read hook's `snapshot` goes to the store hook's `put` on `request.cacheSnapshot`. Only a route that stores
  under tags creates one. The follower re-read passes none.

## Flights and stale entries

- The leader's unref'd timer at `lockTimeout` is required, since `onSend` does not run after `reply.hijack()`,
  `reply.raw.end()` or a handler that never returns. Followers hold no timer.
- `settle` is first-wins and removes only the flight itself, never a newer one under the same key
  (`http/_tests/single_flight.test.ts`).
- Do not add background refresh.

## Observer

- Log on the setup context's `logger`, never `request.log`, which is silent under a caller-supplied `fastify()`.
- Zero-cost when unobserved is kept by construction; no test proves it: `observer?.onX?.({ … })` at every call
  site, `CacheRoute` built by `cacheRouteOf` once per attach and only with an observer present, per-route event
  data (`ttlSeconds`) resolved at attach.
- The observer and the status header are allowed to diverge.

## Stores

- A new store runs `describeHTTPCacheStoreContract` (`http/store.testkit.ts`) before anything else.
- Leave the generic `Cache` in `cache.ts` as it is, unimplemented; the HTTP cache does not run on it.
- A tag is a generation marker recorded with the entry. Do not add a tag-to-keys index.
- `get` fills the `snapshot` with the hinted tags before it looks at the entry, since a miss is what a `put`
  follows. `put` never reads a tag the snapshot holds, and never takes a newer generation over the one in it:
  an older one costs a hit, a newer one serves a response an eviction should have hidden.

### Redis (`store/redis`)

- Four single-key commands: `GET`, `HMGET`, `HSETEX`, `INCR`. No Lua, no `EVAL`, no `MULTI`, no `SCAN` / `KEYS`
  / `FLUSH*`, no command naming two keys. Batch with `Promise.all` instead.
- Both hash fields (`p`, `m`) are written on every put, since `HSETEX` leaves an unnamed field in place. A new
  optional field goes inside `m`.
- `l:` stays free for a store-level lock. A `''` prefix puts nothing in front (`??`, never `||`).
- The Redis 8.0 / Valkey 9.0 requirement is documented, never probed.

### Keyv (`store/keyv`)

- `KeyValueHTTPCacheClient` is a two-method seam. If a `Keyv` or a cache-manager `Cache` stops satisfying it,
  wrap at the call site rather than widening the seam.
- Widen the `cache-manager` / `keyv` range only after re-reading in the new major: `set(key, value, 0)` means
  "never expires", ttl is in milliseconds, and the `Cache` / `Keyv` shape.
- One entry is one JSON envelope written whole. A new field goes inside the envelope.
- A `ttl` that is not positive returns before any call: both backends read `0` as "never expires".

## Known limits, do not report as new

- Entry and marker lookups are separate calls; an eviction landing between them is missed by that read.
- `buildCacheKey` does not escape the `vary` values it joins; escaping would change every key.
- A `GET` in flight during an eviction can store the older response after it only when its read was skipped
  (`no-cache`, `max-age=0`, `Pragma: no-cache`) or failed: that `put` has no snapshot and reads the tags itself.
