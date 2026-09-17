# `@caffeinejs/caching`

Follow the root [`AGENTS.md`](../AGENTS.md). The rules below are specific to this package.

## Opt-in

Installing the plugin is the activating act. `.with(HTTPCaching())` attaches the cache hooks, and only then
do `@CacheControl` / `@CacheInvalidate` (and the `cacheControl()` / `cacheInvalidate()` route extensions) do
anything. An
application that decorates routes with them but never installs the plugin fails at `app.ready()` with
`ErrConfiguration` — a start-up check on the `http/` side, unrelated to anything this package exports.

There is no `enabled` flag. A configuration value that could switch the feature on would let a config file
start a feature nobody asked for.

## Not a feature, not DI-bound

`HTTPCaching(...)` is a plain `HTTPPluginFactory` — `.with(HTTPCaching(...))`, a factory argument, not a
`Feature`. It binds
nothing into the container: `store` and `etagGenerator` are each read once, as the plugin registers, from the
option given (an instance, or an `InjectionToken` resolved with `container.getOptional`). `etagGenerator`
falls back to an internal default (a SHA-1 hash in `_util.ts`'s `generateETag`) when omitted; `store` has no
default — installing without one throws `ErrConfiguration`, and a token that resolves to nothing throws too.
`HTTPCachingOptionsBuilder`
exists only to build that options object fluently (`HTTPCaching(b => b.store(...).etagGenerator(...))`) —
nothing about it is a `FeatureBuilder`.

Named and `fastify-plugin`-wrapped like any other first-party plugin, it installs once per context — the root,
or one route group with `router.plugin(...)` / `@Use(...)` — each with its own store/etagGenerator/header. Two
registrations on the identical context collide the same way two `.with(cors)` calls would.

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

Install `.with(HTTPCaching())` after `.authentication(...)`. Authentication adds a _server-level_
`onRequest`, which already runs before any route-level hook, so this is forward-proofing rather than the only
thing keeping the order.

## `store` / `etagGenerator`: instance or token

Both fields on `HTTPCachingOptions` accept either the value itself or an `InjectionToken` to resolve from the
container — `HTTPCaching` never binds either, it only ever reads. `Cache` is a plain interface (no runtime
identity), so `store` is told apart from a token by shape: a real `Cache` implementation is always an object,
while every valid `InjectionToken` is a class, a `DeferredCtor`, or a branded string/symbol — never a plain
object. `etagGenerator` is told apart by `typeof`: a `string`/`symbol` is a token, a `function` is the
generator itself — a class-shaped token for a function type is not realistic in this DI and is not supported.

Unlike `etagGenerator`, `store` has no default. Omitting it, or passing a token that resolves to nothing,
throws `ErrConfiguration` — callers must supply a `Cache` implementation explicitly, `MemoryCache` included.

`kETagGenerator` (from `keys.ts`) is exported as a convenience token an application can bind its own
`ETagGenerator` under; it is never resolved by default.
