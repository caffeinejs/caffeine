# `@caffeinejs/caching`

Follow the root [`AGENTS.md`](../AGENTS.md). The rules below are specific to this package.

## Opt-in

Installing the plugin is the activating act. `.plugin(HTTPCaching())` attaches the cache hooks, and only then
do `@Cache` / `@CacheInvalidate` (and the `cache()` / `cacheInvalidate()` route extensions) do anything. An
application that decorates routes with them but never installs the plugin fails at `app.ready()` with
`ErrConfiguration` — the adapter checks a decoration (`CACHING_INSTALLED`, from `@caffeinejs/http`) the plugin
stamps on the instance it registers to, since a silent no-op would look like a caching bug.

There is no `enabled` flag. A configuration value that could switch the feature on would let a config file
start a feature nobody asked for.

## Not a feature, not DI-bound

`HTTPCaching(...)` is a plain `HTTPPluginFactory` — `.plugin(HTTPCaching(...))`, not `.extend(...)`. It binds
nothing into the container: `store` and `etagGenerator` are each read once, as the plugin registers, from the
option given (an instance, or an `InjectionToken` resolved with `container.getOptional`) or, failing that, an
internal default (`MemoryCacheStore`, a SHA-1 hash in `_util.ts`'s `generateETag`). `HTTPCachingOptionsBuilder`
exists only to build that options object fluently (`HTTPCaching(b => b.store(...).etagGenerator(...))`) —
nothing about it is a `FeatureBuilder`.

Because it is a plain plugin and never claims a `fastify-plugin` name, it installs like any other reusable
Fastify plugin: more than once, each with its own store/etagGenerator/header, at the root or scoped to one
route group with `router.plugin(...)` / `@Use(...)`.

## Per-route hooks, not a server hook

Caching attaches its Fastify `onRequest` / `onSend` hooks per route, from Fastify's own `onRoute` hook inside
`cachePlugin()`. A route without a cache decorator keeps its hook slots undefined and pays nothing —
`_tests/route_hooks_zero_cost.test.ts` guards this. The plugin takes its resolved `CacheDeps` (`store`,
`etagGenerator`, `statusHeader`) as a parameter — it never reads the container itself — and the `onRoute` hook
reads `routeDef.config` and attaches only where `cache` / `cacheInvalidate` is set.

## Ordering

`onRoute` fires while each route registers, which is after the adapter attached its own hooks — so the cache
hooks run **behind** `@UseGuards`, and a guard runs on a cache hit as well as on a miss. That is deliberate:
a cached response that skipped authorization is a bypass, not an optimization.

Install `.plugin(HTTPCaching())` after `.authentication(...)`. Authentication adds a _server-level_
`onRequest`, which already runs before any route-level hook, so this is forward-proofing rather than the only
thing keeping the order.

## `store` / `etagGenerator`: instance or token

Both fields on `HTTPCachingOptions` accept either the value itself or an `InjectionToken` to resolve from the
container — `HTTPCaching` never binds either, it only ever reads. `store` is told apart by `instanceof
CacheStore`: a real instance vs. anything else being a token. `etagGenerator` is told apart by `typeof`: a
`string`/`symbol` is a token, a `function` is the generator itself — a class-shaped token for a function type
is not realistic in this DI and is not supported.

`kETagGenerator` (from `keys.ts`) is exported as a convenience token an application can bind its own
`ETagGenerator` under; it is never resolved by default.
