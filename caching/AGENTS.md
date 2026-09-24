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
`etagGenerator`, `statusHeader`, `observer`, `storeTimeoutMs`, `varyByQuery`, `maxEntrySizeBytes`, `flights`,
`lockTimeoutMs`) as a parameter — it never reads the container itself — and the `onRoute` hook reads
`routeDef.config` and attaches only where `cache` / `cacheInvalidate` is set.

The store and eviction hooks are hybrids: they finish a response the policy does not store synchronously,
through Fastify's `next`, and hand back a promise only around a store call. Keep that. A response Fastify sends
while a route's read hook is still waiting on the store — its `handlerTimeout` 503 — is over before that hook
returns, and the lifecycle stops there; an `async` hook keeps the reply open a tick longer, and Fastify sends a
second time (`_tests/signals.test.ts` pins it).

## Ordering

`onRoute` fires while each route registers, which is after the adapter attached its own hooks — so the cache
hooks run **behind** `@UseGuards`, and a guard runs on a cache hit as well as on a miss. That is deliberate:
a cached response that skipped authorization is a bypass, not an optimization.

Install `.with(HTTPCaching())` after `.authentication(...)`. Authentication adds a _server-level_
`onRequest`, which already runs before any route-level hook, so this is forward-proofing rather than the only
thing keeping the order.

Install it **before** a plugin that compresses responses. `@fastify/compress` attaches per route too, in install
order: ahead of the cache it hands the store hook a stream, which is neither hashed nor stored, and `onSkip` is
told (`stream`). Behind
it, the cache stores the unencoded payload and the compressor encodes misses and hits alike. The default `ETag`
is strong and hashed before any content-coding, so with a compressor installed the one tag goes out with every
coding; an application that minds passes an `etagGenerator` returning weak tags (`W/"..."`). That caveat is
documented, not coded.

## What a response is told, and what is stored

The policy describes the responses the route caches — a method in `methods` with a status in `statusCodes`.
Any other response (an error, the cache's own `504`, a `POST` under a class-level `@CacheControl`) gets nothing
permissive from it: no `Cache-Control`, no `ETag`, no `Last-Modified`. The one directive that restricts still
applies — a `noStore` route says `no-store` on its errors too. `Vary` goes on every response, through
`appendVary` from `@caffeinejs/http`, which merges into what CORS and the `constraints()` plugin wrote. The one
time it assigns is `*`, which covers every name already there.

A handler is the last word on its own response. A `Cache-Control` it wrote is left as written and that
response is not stored; an `ETag` or `Last-Modified` it wrote is kept and becomes the stored validator.
The two restrictive forms overwrite it: `noStore`, on every response of the route, and `@CacheControl(false)`.

Three more responses are never stored. The response to a `HEAD`: it shares the `GET`'s key, and a route's own
`@Head` handler has no body to offer a later `GET` (RFC 9111 §4). A response that sets a cookie, unless the
route says `privacy: 'public'`: the request that starts a session is not authenticated yet, so the privacy check
below does not see it; `Set-Cookie` stays in `NOT_STORED` either way. And a payload larger than `maxEntrySize`.
The last two are reported to `observer.onSkip`; the `HEAD` is not, being the policy and not an exception to it.
So are a stream (`stream`) and a handler that returned nothing (`empty`, the one shape Fastify hands `onSend`
that is neither a string, a `Buffer` nor a stream): nothing to hash, nothing to replay, a miss again next time.

A request is private when the route says so, when it carries `Authorization`, or when an authentication scheme
identified the client some other way (`request.user.authenticated` — a session cookie, OIDC, forward auth).
Private means `BYPASS`, `Cache-Control: private`, and nothing stored; `privacy: 'public'` is the opt-out. Do not
narrow this back to the header: a cookie-authenticated response in a shared store is a leak.

An entry keeps the response's status code and every header except the connection-specific ones (the names the
response's own `Connection` lists included), `Set-Cookie`, `Content-Length`, `Date`, `Age`, `Access-Control-*` and the status header (`storedHeadersOf`). A hit replays
them, skipping any header an earlier hook already set for _this_ request and merging `Vary`
(`applyStoredHeaders`). A `304` carries only what guides a cache update. A HEAD hit sends the payload so the
server computes the GET's `Content-Length` and drops the body.

Conditional requests are answered off the fresh response as well as off the store: the store hook compares
`If-None-Match` with the tag it just produced. It never compares `If-Modified-Since` with a `Last-Modified` it
stamped itself — equal seconds would answer `304` for changed content.

Durations are checked while the route registers: `ttl` must be at least one second, since `parseDuration`
reads what it cannot parse as `0`, `lru-cache` reads a ttl of `0` as "never expires", and `max-age` is whole
seconds. What goes out in `Cache-Control` is floored, never rounded: a cache downstream must not be told a
lifetime longer than the entry's.

The key is `buildCacheKey` in `_util.ts`, the one derivation. `varyByQuery`, a route's or the install's, is a
`Set` resolved at attach and applied before the query is sorted; unset, the whole query counts. Routes that
share a URL under different constraints share a default key: a constrained route with a `ttl` must list the
constraint's header in `vary`, or have its own `key`, or `ready()` fails. Tags are checked too (`assertTags`):
non-empty strings without a brace, since a brace in a Redis key decides its slot.

## A store that rejects

Never fails a request. A failed `get` is a miss, a failed `put` or eviction is skipped, and each is reported to
`observer.onError`. `HTTPCaching` always installs an observer: when the application's has no `onError`, it is
composed with `storeErrorLogger` (`_observe.ts`), which implements `onError` alone — so every other call site
still short-circuits — and logs on the application logger at most once a minute for each operation.
`onStore` / `onInvalidate` fire only after the store settled.

A store that never answers is not a store that rejects: a node-redis client queues commands while its server is
away. Every store call goes through `withStoreSignal` (`store_signal.ts`) and carries a signal the store is
expected to honour: a read gets the request's own `request.signal` (client gone, or Fastify's `handlerTimeout`)
composed with `storeTimeout`'s on one `AbortController`; a write or an eviction gets the timeout alone — a
leader whose client left has done the work its followers wait for, and an eviction follows a mutation that
already went through. When the timeout is what aborted, the hook rejects with `ErrCacheStoreTimeout` whatever
the store rejects with; when the request is over, the `catch` returns and reports nothing. `HTTPCaching` sets
`storeTimeout` to `2s` unless told otherwise, so every call carries one controller and one timer, both gone when
the call settles — keep the timer cleared on settle, the write path runs on every miss. A hand-built `CacheDeps`
without `storeTimeoutMs` hands the call back as it came: no timer, no second promise.

`request.signal` costs one `AbortController` and one `'close'` listener per request the first time it is read,
unless the server configured `handlerTimeout`, when Fastify pre-creates it. Accepted: a cached route pays a store
read anyway.

## `store` / `etagGenerator`: instance or token

Both fields on `HTTPCachingOptions` accept either the value itself or an `InjectionToken` to resolve from the
container — `HTTPCaching` never binds either, it only ever reads. `HTTPCacheStore` is a plain interface (no
runtime identity), so `store` is told apart from a token by shape: a real store is always an object, while
every valid `InjectionToken` is a class, a `DeferredCtor`, or a branded string/symbol — never a plain object.
`etagGenerator` is told apart by `typeof`: a `string`/`symbol` is a token, a `function` is the generator
itself — a class-shaped token for a function type is not realistic in this DI and is not supported.

Unlike `etagGenerator`, `store` has no default. Omitting it, or passing a token that resolves to nothing,
throws `ErrConfiguration` — callers must supply an `HTTPCacheStore` explicitly, `MemoryHTTPCacheStore` included.

`kETagGenerator` and `kHTTPCacheStore` (`keys.ts`) are convenience tokens an application binds its own values
under; neither is resolved by default. `kHTTPCacheStore` is how a service outside a route evicts: the
application binds the store, hands the token to `.store(...)`, and injects it wherever it evicts by tag.

## Eviction is by tag

`@CacheInvalidate({ tags })` evicts every entry stored under any of its tags, from any route, once the request
is answered with a `2xx` or a `3xx` (RFC 9111 §4.4 — a form post answered with a redirect invalidates). That is
the one form: there is no eviction by path or by key, and nothing rebuilds a key. A route names the tags its
entries are stored under in `@CacheControl({ tags })`, static strings only; a service evicts through the bound
store (`kHTTPCacheStore`). `tags` on `@CacheInvalidate` is required and non-empty, refused at start-up otherwise.

A `key` function on `@CacheControl` is handed `request.httpContext.req`: the request of the context the adapter
gave the request in its first `onRequest` hook, ahead of every route hook. Never build a `FastifyContextRequest`
in this package. On a server the adapter does not drive there is no context, and a `key` function there is
unsupported — documented on the option, deliberately not checked. The hooks pass a route's tags to `store.get`
as a hint, resolved once at attach.

A `GET` in flight during an eviction can still store the older response after it: a documented limit, one
handler run per miss narrows it to one writer per key, and nothing more is built for it.

## One handler run per miss

`flight.ts`: a `Flight` per store key, in a `Map` per install (`CacheDeps.flights`, created by `HTTPCaching`;
a hand-built `CacheDeps` without one runs every miss). A miss that finds no flight leads: it creates one, carried
on `request.cacheFlight`, and runs the handler; a miss that finds one follows: it awaits `flight.done`, re-reads
the store when the leader `stored` (or `rescued`, see below) and serves that, else runs the handler itself and
leads nobody (`onMiss 'not-coalesced'`). A `HEAD` never leads and does follow. `only-if-cached` answers `504`
without waiting. A route that can never store (`lock: false`, no `ttl`, `noStore`) creates no flight.

The leader settles its flight from the store hook, `'stored'` right after the `put` resolved and `'not-stored'`
in a `finally` on every other way out. `onSend` runs on the error handler's response, after a client abort and
for a stream; it does not run after `reply.hijack()`, a raw `reply.raw.end()` or a handler that never returns —
so the Flight's own unref'd timer, at `lockTimeout`, settles `'not-stored'` and is required, and it bounds every
follower at once: followers hold no timer. A follower waits through `Flight.wait(request.signal)` — one `'abort'`
listener — and when its own request ends first it returns from the read hook with nothing served and nothing
reported; Fastify stops the lifecycle at `reply.sent` after its `503`, and goes on as for any hook after a client
left. `settle` is first-wins and removes only the flight itself from the
table, never a newer one under the same key (a leader outliving its timeout). `_tests/single_flight.test.ts`
pins all of it. Nothing here reaches across processes: the `l:` Redis namespace stays free for a store-level
lock, and `HTTPCacheStore` gets no lock or wait verb.

## Stale entries

`staleWhileRevalidate` and `staleIfError` are honoured by the store, leader-pays: past `ttl`, within the window,
and only where the route allows stale (`mustRevalidate`, `proxyRevalidate` and `noCache` forbid it), a request
whose `max-age` / `min-fresh` the entry meets and that did not say `only-if-cached` either follows a flight and is
served the entry (`X-Cache: STALE`, `onHit { stale: true }`) or, with `staleIfError`, carries the entry on
`request.cacheStale` into the handler run. The store hook replaces a `500`, `502`, `503` or `504` with a carried
entry (`replace`): the entry's status, its headers written over the error's (`applyStoredHeaders` in
`'replacement'` mode), `Content-Length` and `Retry-After` removed, a `HEAD` given the entry's length and no body,
`onStaleIfError` reported, and the flight settled `'rescued'` so followers re-read and are served the entry. Nothing
is refreshed in the background: without a handler run there is nobody to pay. The store keeps an entry for `ttl`
plus the longest window (`retentionSeconds`); freshness is decided in the hooks from `storedAt`. A request that
sends `max-stale` (RFC 9111 §5.2.1.2) is served an entry past `ttl` at once and starts no flight: within
`retentionSeconds`, stale by no more than the directive's value, under the same `staleAllowed` rule, and
`only-if-cached` then gets the entry rather than `504`.

## Observer

`observer` is instance-or-token like `store`, never bound. Unlike `etagGenerator`, a token that resolves to
nothing throws `ErrConfiguration`: there is no default, and running without the observer someone named would
only show up as an empty dashboard. There is no convenience token for it — every `CacheObserver` member is
optional, and `token()` refuses a type `{}` satisfies.

The observer has three methods the status header has no value for — `onSkip`, `onInvalidate` and
`onStaleIfError` — and a hit says `stale` and `coalesced`. A rescue is not a second hit: the miss was reported
already, and a second hit would double-count in any ratio computed off the events.

`HTTPCaching` wraps the observer with `guardObserver` (`http/_observe.ts`): a throw never reaches the response,
and neither does the rejection of a promise an `async` method returned, which is caught and never awaited. The
first from each method is logged on the application logger — the `logger` of the setup context — never
`request.log`, which is silent under a caller-supplied `fastify()`.

Zero-cost when unobserved is a code-shape rule no test can fully prove, so keep it by construction:

- every call site is `observer?.onX?.({ … })` — the optional call short-circuits before the event is built;
- `CacheRoute` is built by `cacheRouteOf` once per attach, frozen, and only when an observer is present;
- anything else an event needs per route (`ttlSeconds`) is resolved at attach, not per request.

The observer reports outcomes the status header does not (a method the route does not cache, an
`only-if-cached` 504) and never reads the header — the two are allowed to diverge.

## Stores

The HTTP cache runs on `HTTPCacheStore` (`http/store.ts`): `get(key, { tags?, signal? })`, `put(key, entry, {
ttl, tags?, signal? })`, `evictByTag(tags, { signal? })`. Three verbs, no more: nothing in `http/` needs a
single-key delete or a batch, and a lock or a wait verb belongs to a later, separate capability.
`http/store.testkit.ts` (`describeHTTPCacheStoreContract`) is the contract every store passes —
`MemoryHTTPCacheStore` in its unit test, `RedisHTTPCacheStore` twice: in its unit test over an in-memory fake of
the four commands it sends, and in `store/redis/redis.e2e.ts` against real servers, which the e2e Vitest project
(`test/e2e/vitest.config.ts`) picks up. A new store runs it before anything else. The generic `Cache` in
`caching/cache.ts` is not what the HTTP cache runs on; it is kept as it is, with no implementation, until its
own design.

A tag is a generation counter in both stores. `put` records the counter of each of its tags with the entry,
`get` reads a mismatch as absent, `evictByTag` bumps. An entry the counter left behind is dropped when next
read, overwritten, or expired. A tag-to-keys index was rejected: on Redis it needs `SMEMBERS` and cleanup, in
memory a `dispose` a caller's `LRUCache` would not have. `MemoryHTTPCacheStore` keeps its counters in a `Map`
beside the `LRUCache`, whose values are `{ entry, tags }`; static tags keep that map bounded by the code.

`RedisHTTPCacheStore` is at `@caffeinejs/caching/store/redis`, reachable from no barrel, so an application that
does not import it never loads `@redis/client` — an **optional** peer for that reason, as in `distlock`. It takes
a connected node-redis client through a structural interface and owns nothing about it; `createClient()` and
`createCluster()` both fit, which a type-only test pins.

- Keys are `${prefix}e:${key}` and `${prefix}t:${tag}`; `l:` is kept free. `prefix` is used verbatim, with no
  separator of the store's own, and `''` puts nothing in front (`??`, never `||`). A brace in the prefix or in a
  tag is refused: Redis hashes the first `{...}` of a key.
- One hash per entry, of two fields: `p` the payload as raw bytes, `m` the rest as JSON, its `g` the counter of
  each tag the entry was written under. Written with one `HSETEX ... PX`, which is why the store needs
  **Redis 8.0 or Valkey 9.0** — documented, never probed; an older server rejects every write and the cache fails
  open. `HSETEX` leaves a field it does not name in place with its old TTL, so **both fields are written on every
  put**: do not add an optional field, put it inside `m`. The `PX` value is pinned by a unit test: dropping the
  `* 1000` passed every other test.
- **No Lua, no `EVAL`, no `MULTI`, no `SCAN` / `KEYS` / `FLUSH*`, no command naming two keys**: four single-key
  commands, `GET`, `HMGET`, `HSETEX`, `INCR`. Efficiency is batching: node-redis writes every command issued in
  one event-loop tick in one socket write, so a `Promise.all` of single-key commands is one round trip on a
  server and one fan-out on a cluster. A hinted `get` is one round trip (`HMGET` and the tag `GET`s together;
  only a tag the entry carries that the hint did not name costs a second batch), a `put` two (the counters, then
  the `HSETEX`; one for an untagged entry), an eviction one.
  A batch is awaited as one so that no command is left to reject unhandled.
- Every call binds the signal it is handed to every command of the call: `withTypeMapping(...).withAbortSignal(...)`
  on a single-server client, which keeps the client's default command options, and `withCommandOptions({
typeMapping, abortSignal })` on a cluster client, which has no `withAbortSignal` and whose `withCommandOptions`
  replaces them — so on a cluster a call runs under `storeTimeout` and not the client's command timeout. A queued
  command is taken out of the client's offline queue when the signal aborts, which a unit test proves on a real
  `createClient()` that never reaches its server. Every key of a call is derived before a command goes out, so a
  refused tag sends nothing.
- The e2e spec runs on Redis and Valkey, each as one server and as a one-node cluster (which still answers
  `CROSSSLOT`), and asserts what was never sent. `test/e2e/caching.chaos.e2e.ts` runs the whole HTTP cache through
  a staged outage of the standalone servers — a TCP relay in `test/e2e/internal/tcp_proxy.ts` holds replies,
  drops connections and refuses new ones — and asserts every request is answered by the handler meanwhile. The
  clusters are not rows there: a cluster client dials the addresses the nodes announce, past any relay.

Two limits are known and accepted; do not report them as new. The entry `HMGET` and the counter `GET`s of a read
are separate commands, so an eviction from another connection landing between them is missed by that one read.
And `buildCacheKey` does not escape the `vary` values it joins, so two requests crafted with the separator in a
header value can share a key; a request without it cannot be reached, and escaping would change every key.
