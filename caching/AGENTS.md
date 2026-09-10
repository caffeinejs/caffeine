# `@caffeinejs/caching`

Follow the root [`AGENTS.md`](../AGENTS.md). The rules below are specific to this package.

## Opt-in

Installing the feature is the activating act. `.extend(caching())` binds the store, registers the
`CacheRouteContributor`, and only then do `@Cache` / `@CacheInvalidate` (and the `cache()` /
`cacheInvalidate()` route extensions) do anything. An application that decorates routes with them but never
installs the feature fails at `app.ready()` with `ErrConfiguration` — a silent no-op would look like a
caching bug.

There is no `enabled` flag. A configuration value that could switch the feature on would let a config file
start a feature nobody asked for.

## Per-route hooks, not a server hook

Caching attaches its Fastify `onRequest` / `onSend` hooks per route, through the `RouteContributor` seam
(public in `@caffeinejs/http`). A route without a cache decorator keeps its hook slots undefined and pays
nothing — `_tests/route_hooks_zero_cost.test.ts` guards this. `CacheRouteContributor.configure` resolves
`CacheStore` / `kETagGenerator` / `kCacheStatusHeader` once at start-up; `onRoute` reads `routeDef.config`
and attaches only where `cache` / `cacheInvalidate` is set.

## Ordering

The contributor is in the `gate` stage. Install `caching` after `authentication` — a cache hit must not
serve ahead of the authentication hook. Authentication adds a _server-level_ `onRequest`, which already runs
before any route-level hook, so this is forward-proofing rather than the only thing keeping the order.

## Where values go

`statusHeader` is configuration: it lives in the `cache.*` slice, so `CACHE__STATUS_HEADER=X-Edge`
overrides whatever `c.statusHeader(...)` set. `store` and `etagGenerator` cannot be configuration — one is
an instance, the other a function — so they stay builder-only fields, set with `c.store(...)` /
`c.etagGenerator(...)`. `cacheConfigSchema` is exported for an application to splice into its own schema and
point the feature at with `.config(c => c.app.cache)`.

`CacheBuilder.bootstrap` binds a default `MemoryCacheStore` only when nothing else bound `CacheStore`.
