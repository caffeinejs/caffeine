# `@caffeinejs/caching`

Follow the root [`AGENTS.md`](../AGENTS.md). The rules below are specific to this package.

## Opt-in

Installing the feature is the activating act. `.extend(caching())` binds the store, contributes the cache
plugin, and only then do `@Cache` / `@CacheInvalidate` (and the `cache()` / `cacheInvalidate()` route
extensions) do anything. An application that decorates routes with them but never installs the feature fails
at `app.ready()` with `ErrConfiguration` — the adapter checks `fastify.hasPlugin('caffeine-caching')`, since a
silent no-op would look like a caching bug.

There is no `enabled` flag. A configuration value that could switch the feature on would let a config file
start a feature nobody asked for.

## Per-route hooks, not a server hook

Caching attaches its Fastify `onRequest` / `onSend` hooks per route, from Fastify's own `onRoute` hook inside
`cachePlugin()`. A route without a cache decorator keeps its hook slots undefined and pays nothing —
`_tests/route_hooks_zero_cost.test.ts` guards this. The plugin resolves `CacheStore` / `kETagGenerator` /
`kCacheStatusHeader` once as it registers; the `onRoute` hook reads `routeDef.config` and attaches only where
`cache` / `cacheInvalidate` is set.

## Ordering

`onRoute` fires while each route registers, which is after the adapter attached its own hooks — so the cache
hooks run **behind** `@UseGuards`, and a guard runs on a cache hit as well as on a miss. That is deliberate:
a cached response that skipped authorization is a bypass, not an optimization.

Extend `caching()` after `.authentication(...)`. Authentication adds a _server-level_ `onRequest`, which
already runs before any route-level hook, so this is forward-proofing rather than the only thing keeping the
order.

## Where values go

`statusHeader` can come from the configuration, which is what `.withConfig(c.app.cache)` is for — read
through, so a refresh reaches the header name. `.statusHeader(...)` wins over it, like every other fluent
method. `store` and `etagGenerator` cannot be configuration — one is an instance, the other a function — so
they are builder-only. `cacheConfigSchema` is exported for an application to splice into its own schema.

`CacheBuilder.bootstrap` binds a default `MemoryCacheStore` only when nothing else bound `CacheStore`.
