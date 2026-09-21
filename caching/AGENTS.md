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
option given (an instance, or an `InjectionToken` resolved with `container.getOptional`). An omitted
`etagGenerator` is the internal default (a SHA-1 hash in `_util.ts`'s `generateETag`); `store` has no
default — installing without one throws `ErrConfiguration`. A token that resolves to nothing throws for all
three of `store`, `etagGenerator` and `observer`: a binding someone named and forgot is a mistake, not a request
for the default.
`HTTPCachingOptionsBuilder`
exists only to build that options object fluently (`HTTPCaching(b => b.store(...).etagGenerator(...))`) —
nothing about it is a `FeatureBuilder`.

Named and `fastify-plugin`-wrapped like any other first-party plugin, it installs once per context — the root,
or one route group with `router.plugin(...)` / `@Use(...)` — each with its own store/etagGenerator/header. Two
registrations on the identical context collide the same way two `.with(cors)` calls would. The adapter's
start-up refusal reads each group's own scopes, so a group that installed the plugin for itself is served and a
sibling that declared caching and installed nothing is still refused.

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

Install it **before** a plugin that compresses responses. `@fastify/compress` attaches per route too, in install
order: ahead of the cache it hands the store hook a stream, which is neither hashed nor stored, silently. Behind
it, the cache stores the unencoded payload and the compressor encodes misses and hits alike. The default `ETag`
is strong and hashed before any content-coding, so with a compressor installed the one tag goes out with every
coding; an application that minds passes an `etagGenerator` returning weak tags (`W/"..."`). That caveat is
documented, not coded.

## What a response is told, and what is stored

The policy describes the responses the route caches — a method in `methods` with a status in `statusCodes`.
Any other response (an error, the cache's own `504`, a `POST` under a class-level `@CacheControl`) gets nothing
permissive from it: no `Cache-Control`, no `ETag`, no `Last-Modified`. The one directive that restricts still
applies — a `noStore` route says `no-store` on its errors too. `Vary` goes on every response, merged with
`appendVary` from `@caffeinejs/http`, never assigned: CORS and the `constraints()` plugin write it as well.

A handler is the last word on its own response. A `Cache-Control` it wrote is left as written and that
response is not stored; an `ETag` or `Last-Modified` it wrote is kept and becomes the stored validator.
`@CacheControl(false)` alone overwrites, being the restrictive form.

A request is private when the route says so, when it carries `Authorization`, or when an authentication scheme
identified the client some other way (`request.user.authenticated` — a session cookie, OIDC, forward auth).
Private means `BYPASS`, `Cache-Control: private`, and nothing stored; `privacy: 'public'` is the opt-out. Do not
narrow this back to the header: a cookie-authenticated response in a shared store is a leak.

An entry keeps the response's status code and every header except the connection-specific ones, `Set-Cookie`,
`Content-Length`, `Date`, `Age`, `Access-Control-*` and the status header (`storedHeadersOf`). A hit replays
them, skipping any header an earlier hook already set for _this_ request and merging `Vary`
(`applyStoredHeaders`). A `304` carries only what guides a cache update. A HEAD hit sends the payload so the
server computes the GET's `Content-Length` and drops the body.

Conditional requests are answered off the fresh response as well as off the store: the store hook compares
`If-None-Match` with the tag it just produced. It never compares `If-Modified-Since` with a `Last-Modified` it
stamped itself — equal seconds would answer `304` for changed content.

Durations are checked while the route registers: `ttl` must be positive, since `parseDuration` reads what it
cannot parse as `0` and `lru-cache` reads a ttl of `0` as "never expires".

Routes that share a URL under different constraints share a default key. A constrained route with a `ttl` must
list the constraint's header in `vary`, or have its own `segment` or `key`, or `ready()` fails. A shared
`segment` passes the check and still collides — accepted, and said in the `segment` TSDoc: one segment per
version.

## A store that rejects

Never fails a request. A failed `get` is a miss, a failed `put` or eviction is skipped, and each is reported to
`observer.onError`. `HTTPCaching` always installs an observer: when the application's has no `onError`, it is
composed with `storeErrorLogger` (`_observe.ts`), which implements `onError` alone — so every other call site
still short-circuits — and logs on the application logger at most once a minute for each operation.
`onStore` / `onInvalidate` fire only after the store settled.

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

## Invalidation targets the key the cache stored

`@CacheInvalidate` has three forms, never mixed: `paths`, `key`, or `clear` with a `segment`. It runs for a
`2xx` or a `3xx` (RFC 9111 §4.4 — a form post answered with a redirect invalidates). Every key is derived by
one function, `buildCacheKey` in `_util.ts`: `defaultCacheKey`, `pathCacheKey` and the exported `cacheKey(req,
options)` helper all call it, and `_util.prop.test.ts` pins that they agree for any query order.

That an eviction must use the exact key the cache stored is **deliberately not enforced** in code: the TSDoc on
both `key` options states it, and `cacheKey` makes the matching key easy to derive from the evicting request
(`{ method: 'GET' }`, `{ url }`, `{ vary, headers }` for one variant). Do not add a start-up check. A path cannot reach a route that varies (one entry per
`Vary` combination); that route belongs in a segment, invalidated with `clear`. `clear` without a `segment`
would empty the whole store, so it fails at `app.ready()` with `ErrConfiguration`, as does mixing forms.

## Observer

`observer` is instance-or-token like `store`, never bound. Unlike `etagGenerator`, a token that resolves to
nothing throws `ErrConfiguration`: there is no default, and running without the observer someone named would
only show up as an empty dashboard. There is no convenience token for it — every `CacheObserver` member is
optional, and `token()` refuses a type `{}` satisfies.

`HTTPCaching` wraps the observer with `guardObserver` (`http/_observe.ts`): a throw never reaches the response,
and the first throw from each method is logged on the application logger (`logToken()`), never `request.log`,
which is silent under a caller-supplied `fastify()`.

Zero-cost when unobserved is a code-shape rule no test can fully prove, so keep it by construction:

- every call site is `observer?.onX?.({ … })` — the optional call short-circuits before the event is built;
- `CacheRoute` is built by `cacheRouteOf` once per attach, frozen, and only when an observer is present;
- anything else an event needs per route (`ttlSeconds`) is resolved at attach, not per request.

The observer reports outcomes the status header does not (a method the route does not cache, an
`only-if-cached` 504) and never reads the header — the two are allowed to diverge.

## Stores

The store verbs are `get` / `getMany` / `put` / `putMany` / `delete` / `deleteMany` / `clear`. `getMany` is
aligned to its keys; each `putMany` item carries its own `ttl`. The batch reads and writes have no caller in
`http/`: the hooks stay on the single-key ones. `store.testkit.ts` (`describeCacheContract`) is the contract
every store passes — `MemoryCache` in its unit test, `RedisCache` in `store/redis/redis.e2e.ts`, which the e2e Vitest project (`test/e2e/vitest.config.ts`) picks up. A new store
runs it before anything else.

`RedisCache` is at `@caffeinejs/caching/store/redis`, reachable from no barrel, so an application that does not
import it never loads `@redis/client` — an **optional** peer for that reason, as in `distlock`. It takes a
connected node-redis client through a structural interface and owns nothing about it; `createClient()` and
`createCluster()` both fit, which a type-only test pins.

- One hash per entry, payload as raw bytes, read with `HMGET` on a fixed field list through a view whose bulk
  replies are Buffers (`withTypeMapping`).
- `clear(segment)` is one `INCR` on the segment's generation counter; an entry carries the generation it was
  written under and the store compares it after a pipelined read. `clear()` without a segment rejects.
- `SCAN`, `KEYS`, `FLUSH*` and every multi-key command are forbidden: no `MGET`, no multi-key `UNLINK`. A batch
  is single-key commands issued together. The write script is the one command naming two keys — the entry and
  its counter — and they share a hash tag, which is a function of the **segment only** (`hashTag` option).
- The e2e spec runs on Redis and Valkey, each as one server and as a one-node cluster (which still answers
  `CROSSSLOT`), and asserts what was never sent.

Cache stampede protection is not built, and room is kept for it: the `l:` key namespace beside `e:` and `g:`,
under the segment's tag; `Cache` stays a plain contract, coordination arriving later as a separate optional
capability a store may implement; and the hooks derive the store key once per request, carried on
`request.cacheKey`, which leaves one place to wait between a miss and the handler and one to release after
`put`. Do not add lock or wait methods to `Cache`, and do not derive the key a second time.
