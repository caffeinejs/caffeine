# @caffeinejs/caching

HTTP response caching for a Caffeine web application: a server-side store in front of your handlers, and the
`Cache-Control`, `ETag`, `Last-Modified`, `Vary` and `Age` headers that let browsers and proxies cache too.
Follows RFC 9110, RFC 9111 and RFC 5861.

```sh
npm install @caffeinejs/caching
```

| Import                             | What it holds                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@caffeinejs/caching/http`         | `HTTPCaching`, `@CacheControl`, `@CacheInvalidate`, `HTTPCacheStore`, `kHTTPCacheStore`, observers            |
| `@caffeinejs/caching/store/memory` | `MemoryHTTPCacheStore`, an in-process LRU store                                                               |
| `@caffeinejs/caching/store/redis`  | `RedisHTTPCacheStore`, for Redis or Valkey, one server or a cluster                                           |
| `@caffeinejs/caching`              | The general-purpose `Cache` contract: `Cache`, `CacheEntry`, `CachePutItem`. Not what the HTTP cache runs on. |

## Quick start

Two halves: install the plugin once, then say which routes cache. Decorating routes without installing the
plugin fails at `app.ready()`. There is no default store: you pass one.

```ts
import { Controller, Get, Put, createWebApplication } from '@caffeinejs/http'
import { CacheControl, CacheInvalidate, HTTPCaching } from '@caffeinejs/caching/http'
import { MemoryHTTPCacheStore } from '@caffeinejs/caching/store/memory'

@Controller('/pets')
class PetsController {
  @CacheControl({ ttl: '5m', tags: ['pets'] })
  @Get('/')
  list() {
    return petStore.all()
  }

  // Evicts every entry stored under `pets`, once this answers with a 2xx or a 3xx.
  @CacheInvalidate({ tags: ['pets'] })
  @Put('/:id')
  update() {
    // ...
  }
}

const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
await app.run()
```

The first `GET /pets` runs the handler and answers `X-Cache: MISS`. For the next five minutes the same request is
answered from the store with `X-Cache: HIT` and an `Age` header, and the handler does not run. Concurrent
requests for a response that is not stored yet run the handler once, not once each.

`@CacheControl` on a class applies to every route of the controller. The same options are available without
decorators, as route extensions:

```ts
import { Router } from '@caffeinejs/http'
import { cacheControl, cacheInvalidate } from '@caffeinejs/caching/http'

const pets = new Router('/pets')
pets
  .get('/')
  .with(cacheControl({ ttl: '5m', tags: ['pets'] }))
  .handler(() => petStore.all())
pets
  .post('/')
  .with(cacheInvalidate({ tags: ['pets'] }))
  .handler(() => ({ created: true }))
```

A duration is a number of seconds or a string such as `'30s'`, `'5m'`, `'1h'`, `'1d'`. A `ttl` is at least one
second: `max-age` is whole seconds.

## What is cached

A response is stored when all of these hold:

- the route has a `ttl`, and does not say `noStore`
- the request method is in `methods` (default `GET` and `HEAD`) and the status is in `statusCodes` (default `200`)
- the request is not a `HEAD`: a `HEAD` is answered from what a `GET` stored, and never fills the store itself
- the request is not private (see below), and did not say `Cache-Control: no-store`
- the route does not vary on `*`
- the handler did not write its own `Cache-Control` header
- the response sets no cookie, unless the route says `privacy: 'public'`
- the payload is a string or a `Buffer`, not a stream, and no larger than `maxEntrySize`

A hit replays the stored status code and headers. Connection-specific headers (the ones the response's own
`Connection` names included), `Set-Cookie`, `Content-Length`, `Date`, `Age`, `Access-Control-*` and the cache
status header are never stored, so each response gets its own. A header that an earlier hook already set for the
current request is kept over the stored one, and `Vary` is merged, never replaced.

A route with no `ttl` stores nothing. It still sends an `ETag`, so clients can revalidate, and whatever policy it
declared: `@CacheControl({ noCache: true })` sends `Cache-Control: no-cache`, while `@CacheControl()` alone has no
directive to send and sends no `Cache-Control`.

### Private requests

A request is private when the route says `privacy: 'private'`, when it carries an `Authorization` header, or when
an authentication scheme identified the client some other way, a session cookie for one. A private request is
answered `Cache-Control: private`, marked `X-Cache: BYPASS`, and nothing is stored. A route whose response is the
same for everyone opts out with `privacy: 'public'`.

A response that sets a cookie is taken for one client's too, and is not stored: the request that starts a session
is not authenticated yet, so nothing else would keep its body out of the store. `privacy: 'public'` stores it, and
the cookie itself still never goes to the store.

### The handler decides for its own response

A `Cache-Control` header written by the handler is left as written, and that response is not stored. An `ETag`
or `Last-Modified` written by the handler is kept and becomes the stored validator. The two restrictive forms
are the exception: `noStore` always writes `no-store`, and `@CacheControl(false)` the full set of no-cache headers.

### Responses the route does not cache

An error, a status outside `statusCodes`, or a method outside `methods` gets nothing permissive from the policy:
no `Cache-Control`, no `ETag`, no `Last-Modified`. A `noStore` route still says `no-store` on those responses.
`Vary` goes on every response of the route.

## Requests

| Request                                  | Effect                                                                |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `Cache-Control: no-cache`, `max-age=0`   | Not answered from the store. The fresh response is stored.            |
| `Cache-Control: no-store`                | Not answered from the store, and the response is not stored.          |
| `Cache-Control: max-age=N`               | An entry older than `N` seconds is a miss, never a stale answer.      |
| `Cache-Control: min-fresh=N`             | An entry with less than `N` seconds of freshness left is a miss.      |
| `Cache-Control: only-if-cached`          | Answered from the store, or `504` when nothing fresh is. Never waits. |
| `Pragma: no-cache`                       | Read only when the request has no `Cache-Control` header.             |
| `If-None-Match` on a `GET` or `HEAD`     | `304` when it matches, on a hit and on a miss alike.                  |
| `If-Modified-Since` on a `GET` or `HEAD` | `304` when it matches, on a hit. On a miss, see below.                |

Directive names are matched case-insensitively. `max-stale` is not read. `If-None-Match` wins over
`If-Modified-Since` when both are sent. On a miss, `If-Modified-Since` is compared only with a `Last-Modified`
the handler wrote. The one the cache stamps is as old as the response itself, and would match a copy from earlier
in the same second whatever had changed.

Of the stored headers, a `304` answered from the store carries only `Cache-Control`, `Content-Location`, `ETag`,
`Expires`, `Last-Modified` and `Vary`, next to its own `Age` and status header. A `304` on a miss is the handler's
own response with the body and `Content-Length` taken off, so it keeps that response's other headers,
`Content-Type` included. A `HEAD` hit carries the `Content-Length` the `GET` would have.

The status header is `X-Cache` by default, renamed with `.statusHeader(...)`:

| Value    | Meaning                                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------- |
| `HIT`    | Answered from the store, with the stored body or with a `304`.                                                 |
| `MISS`   | The handler ran. The response was stored if it qualified.                                                      |
| `STALE`  | Answered with an entry past its `ttl`, under `staleWhileRevalidate` or `staleIfError`.                         |
| `BYPASS` | The store was not consulted: a private request, a request directive, `vary: ['*']`, or `@CacheControl(false)`. |

A request whose method is not in `methods` gets no status header at all: the cache has nothing to say about it.
An observer still hears of it, as `onBypass` with `reason: 'method'`.

## `@CacheControl` options

| Option                                                                     | Meaning                                                                                                                                                                                  |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ttl`                                                                      | How long a response is fresh: the entry's lifetime in the store and the `max-age` sent, in whole seconds rounded down. At least one second. Without it nothing is stored.                |
| `sharedMaxAge`                                                             | Sent as `s-maxage`.                                                                                                                                                                      |
| `staleWhileRevalidate`                                                     | How long past `ttl` an entry is still served while the handler produces a fresh one. Sent, and honoured by the store: see "Stale entries".                                               |
| `staleIfError`                                                             | How long past `ttl` an entry stands in for a `500`, `502`, `503` or `504` the handler produces. Sent, and honoured by the store: see "Stale entries".                                    |
| `noStore`                                                                  | Sends `no-store` on every response of the route, errors included, over the handler's own `Cache-Control`, and stores nothing.                                                            |
| `noCache`, `mustRevalidate`, `proxyRevalidate`, `noTransform`, `immutable` | The directive of the same name. The first three also turn stale serving off.                                                                                                             |
| `privacy`                                                                  | `'private'` keeps the response out of the store. `'public'` stores it even for an identified client.                                                                                     |
| `vary`                                                                     | Request headers the response depends on. Added to `Vary`, and their values become part of the key. `['*']` is never stored.                                                              |
| `varyByQuery`                                                              | The query parameters the key carries. Others, `utm_source` for one, do not fragment the cache. `[]` leaves the whole query out. Unset, the install's list applies, else the whole query. |
| `tags`                                                                     | What the entry is stored under, for `@CacheInvalidate` and `HTTPCacheStore.evictByTag`. Non-empty strings without `{` or `}`.                                                            |
| `lock`                                                                     | `false` lets every concurrent miss run the handler. On by default: see "One handler run per miss".                                                                                       |
| `etag`                                                                     | `false` sends no generated `ETag`. Storing does not depend on it.                                                                                                                        |
| `methods`                                                                  | Methods whose responses are cached. Default `GET`, `HEAD`. Case-insensitive.                                                                                                             |
| `statusCodes`                                                              | Statuses that are cached, and replayed as they were. Default `200`.                                                                                                                      |
| `key`                                                                      | Derives the store key instead of the default.                                                                                                                                            |
| `etagGenerator`                                                            | Hashes the payload for this route, instead of the one given to `HTTPCaching`.                                                                                                            |

`@CacheControl(false)` turns caching off for a route under a class-level `@CacheControl`, and sends
`Cache-Control: no-store, max-age=0, must-revalidate, proxy-revalidate` with the matching `Expires`, `Pragma` and
`Surrogate-Control`.

Caching an unsafe method is allowed and is yours to get right: the default key never reads the body, so a
`POST` listed in `methods` is answered with whatever the first `POST` to that URL produced, unless `key` tells
the requests apart.

## Keys

The default key is the URL with its query parameters sorted, so `?a=1&b=2` and `?b=2&a=1` share an entry. With
`varyByQuery`, only the parameters named count: `@CacheControl({ ttl: 60, varyByQuery: ['page', 'q'] })` gives
`/pets?page=2&utm_source=mail` and `/pets?page=2` one entry. `GET` and `HEAD` share a key; any other method is
part of it. With `vary`, the value of each listed request header is appended, which gives one entry per
combination.

Routes selected by a constraint, a version or a host, share their URL with the routes selected otherwise, and so
would share a key. Such a route with a `ttl` must list the constraint's header in `vary`, or have its own `key`.
Otherwise `app.ready()` fails.

```ts
@CacheControl({ ttl: 60, vary: ['Accept-Version'] })
```

## Invalidation

Eviction is by tag. A route names the tags its entries are stored under, and a mutating route names the tags it
evicts; every entry stored under any of them goes, whatever route stored it, whatever its key or `Vary` variant.

```ts
@CacheControl({ ttl: '5m', tags: ['pets', 'catalogue'] })
@Get('/')
list() {}

// After a 2xx or a 3xx, so a form post answered with a redirect evicts as well.
@CacheInvalidate({ tags: ['pets'] })
@Put('/:id')
update() {}
```

A service evicts the same way, through the store. Bind it under `kHTTPCacheStore` and hand the token to
`HTTPCaching`; anything can inject it then — a message consumer, a job, another route's handler:

```ts
import { HTTPCaching, kHTTPCacheStore, type HTTPCacheStore } from '@caffeinejs/caching/http'

container.bind(kHTTPCacheStore, t => t.toValue(new RedisHTTPCacheStore(client)))
app.with(HTTPCaching(b => b.store(kHTTPCacheStore)))

class PetsConsumer {
  constructor(@Inject(kHTTPCacheStore) private readonly cache: HTTPCacheStore) {}

  async onPetChanged() {
    await this.cache.evictByTag('pets')
  }
}
```

An eviction is a counter moving, not a walk over the entries: it costs the same whether a tag covers one entry
or a million. An entry the counter left behind is gone the next time it is read, and is dropped by its own `ttl`
at the latest.

## One handler run per miss

Concurrent requests that miss on one key run the handler once. The first to miss leads and runs the handler; the
requests behind it wait for what it stores, up to `lockTimeout` (default `10s`), and are served that. When the
leader stored nothing — a private response, an error, a cookie, a write that failed — they run the handler
themselves. A `HEAD` never leads, since its response is never stored, but it does wait. The wait is in this
process: with several replicas, each runs the handler once.

`@CacheControl({ lock: false })` takes a route out of it. A route whose handler hijacks the reply or streams
should: such a response stores nothing and settles nothing before the timeout, so its followers would wait
`lockTimeout` for nothing.

## Stale entries

Past its `ttl` an entry is not fresh, and by default not served. The two windows a route declares change that,
for the server-side store as well as for caches downstream:

- `staleWhileRevalidate: '30s'` — for thirty seconds past `ttl`, the first request to find the entry stale runs
  the handler, and the requests behind it are served the stale entry at once instead of waiting for it. Nobody
  on a route with `lock: false`: there is no leader to wait on, and the entry is a miss.
- `staleIfError: '10m'` — for ten minutes past `ttl`, a `500`, `502`, `503` or `504` the handler produces goes out
  replaced by the entry: its status, its headers over the error's, its payload. The requests waiting on that
  handler run are served it too. Nothing is stored.

A stale answer is marked `X-Cache: STALE`, with an `Age` above `max-age`. The store keeps an entry for `ttl`
plus the longest of the two windows. Neither applies under `mustRevalidate`, `proxyRevalidate` or `noCache`,
neither to `only-if-cached`, and neither to a request whose `max-age` or `min-fresh` the entry does not meet.

## Installing

`HTTPCaching` takes an options object or a builder callback. The callback's second argument is the setup
context, with the `container` and the application `logger`.

```ts
.with(
  HTTPCaching((b, { logger }) =>
    b
      .store(new MemoryHTTPCacheStore({ max: 1_000, maxSize: '64MB' }))
      .statusHeader('X-Cache')
      .varyByQuery(['page', 'q'])
      .maxEntrySize('1MB')
      .storeTimeout('250ms')
      .lockTimeout('5s')
      .observer(loggingCacheObserver(logger)),
  ),
)
```

| Option          | Meaning                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `store`         | The `HTTPCacheStore`, or a token it is bound under. Required.                                                                             |
| `etagGenerator` | The function hashing a payload into an `ETag`, or a token. Defaults to an internal SHA-1 hash.                                            |
| `observer`      | A `CacheObserver`, or a token. See "Observing".                                                                                           |
| `statusHeader`  | The cache status header's name. Default `X-Cache`.                                                                                        |
| `varyByQuery`   | The query parameters a key carries, for every route that does not list its own.                                                           |
| `maxEntrySize`  | The largest payload stored: `'1MB'`, `'512kb'`, or a number of bytes. A larger response goes out and is not stored, and `onSkip` is told. |
| `storeTimeout`  | How long one store call may take. Default `2s`. See "When the store fails".                                                               |
| `lockTimeout`   | How long a request waits for another's handler run. Default `10s`.                                                                        |

`store`, `etagGenerator` and `observer` each take the value or a container token. A token bound to nothing fails
at `app.ready()`, and so does a missing `store`. Nothing is bound into the container for you.

It installs on the whole application, or on one route group with `router.plugin(HTTPCaching(...))` or
`@Use(HTTPCaching(...))`, each install with its own store and settings. A group that declares caching and
installs nothing, under an application that installs nothing, fails at `app.ready()`.

Order matters in two places:

- Install it after `.authentication(...)`. Guards run before the cache, on a hit as well as on a miss, so a
  cached response never skips authorization.
- Install it before a plugin that compresses responses. Installed after one, the cache is handed a stream, which
  is neither hashed nor stored, and `onSkip` is told (`stream`).

The default `ETag` is a strong tag hashed from the payload before any content-coding. Behind a compressor, the
one tag goes out with every coding; if that matters, pass an `etagGenerator` that returns weak tags (`W/"..."`).

## Stores

### `MemoryHTTPCacheStore`

An LRU in the process. `max` caps the number of entries (default 500); `maxSize` caps the summed bytes of
payloads and headers (`'512kb'`, `'64MB'`, or a number of bytes). It also takes a pre-built `LRUCache` for the
settings those two do not cover. Each replica has its own, so an eviction on one replica does not reach the
others.

### `RedisHTTPCacheStore`

For Redis 8.0 or later, or Valkey 9.0 or later: entries are written with `HSETEX`, and an older server rejects
every write, which shows as a store failure in the log and a cache that never fills. Needs `@redis/client`, an
optional peer that is loaded only when you import this path.

```ts
import { createClient } from '@redis/client'
import { RedisHTTPCacheStore } from '@caffeinejs/caching/store/redis'

const client = createClient({ url: process.env.REDIS_URL })
await client.connect()

const store = new RedisHTTPCacheStore(client, { prefix: 'myapp:cache:' })
```

- The client is yours. The store never connects, closes or reconnects it. A client from `createClient()` and
  one from `createCluster()` both fit.
- An entry is one hash, with the payload stored as the bytes it was given. A tag is a counter. A read is one
  round trip: the entry and its tags' counters go out together. A write is two, an eviction one.
- It never sends `SCAN`, `KEYS`, `FLUSHDB`, `FLUSHALL`, `MULTI`, a script, or a command naming two keys, so it
  is safe on a cluster and on a shared server.
- Every call carries the signal the cache hands it, so a command a request gave up on is taken out of the
  client's queue. On a single-server client that keeps the client's own command options; a cluster client has
  no way to bind a signal without replacing them, so there a call runs under `storeTimeout` and not the client's
  command timeout.
- Run the server with `noeviction` or a `volatile-*` policy. Under `allkeys-*` the server may evict a tag's
  counter, and entries evicted earlier can become readable again until their own `ttl`.
- `prefix` is put in front of every key as given, with no separator of the store's own: `''` puts nothing in
  front. It may not contain `{` or `}`, and neither may a tag: `ErrRedisCache`.

### Your own

Implement `HTTPCacheStore` from `@caffeinejs/caching/http`:

```ts
interface HTTPCacheStore {
  get(key: string, options?: { tags?: readonly string[]; signal?: AbortSignal }): Promise<HTTPCacheEntry | undefined>
  put(
    key: string,
    entry: HTTPCacheEntry,
    options: { ttl: Duration; tags?: readonly string[]; signal?: AbortSignal },
  ): Promise<void>
  evictByTag(tags: string | readonly string[], options?: { signal?: AbortSignal }): Promise<void>
}
```

- An entry past its `ttl` reads as `undefined`, and so does one stored under a tag evicted since. A `ttl` that
  is not positive stores nothing.
- The `tags` a read is handed are a hint — the route's tags, so a store that keeps tags apart from entries can
  read both in one go. The answer is the same with or without it.
- A `Buffer` payload comes back a `Buffer`, byte for byte; a string comes back a string.
- A call whose signal is aborted stops what it can and rejects; one made with a signal already aborted rejects
  and does nothing.

`describeHTTPCacheStoreContract` in `caching/http/store.testkit.ts` is the contract as a Vitest suite; both
stores pass it.

## When the store fails

A store that rejects never fails a request. A failed `get` is a miss, a failed `put` or eviction is skipped, and
the response the handler produced goes out unchanged. Each failure goes to `observer.onError`. Without an observer
listening for it, the failure is logged on the application logger, at most once a minute for each operation.

A store that never answers is bounded by the signal each call carries. A read is bounded by the request's own
signal — the client gone, or the server's handler timeout — and by `storeTimeout`; a write or an eviction by
`storeTimeout` alone, since the entry is for the requests that follow and the eviction follows a mutation that
already went through. A call past `storeTimeout` is given up on and reported like a rejection, with an
`ErrCacheStoreTimeout`. The default is `2s`. A read given up on because the request is over is not reported.

```ts
HTTPCaching(b => b.store(store).storeTimeout('250ms'))
```

## Observing

A `CacheObserver` is told of every outcome. Every method is optional, and an observer that throws, or whose
returned promise rejects, never reaches the response. A returned promise is not awaited.

```ts
import { composeObservers, loggingCacheObserver, type CacheObserver } from '@caffeinejs/caching/http'

const metrics: CacheObserver = {
  onHit: e => hits.add(1, { route: e.route.url, revalidated: e.revalidated, stale: e.stale }),
  onMiss: e => misses.add(1, { route: e.route.url, reason: e.reason }),
  onError: e => storeErrors.add(1, { operation: e.operation }),
}

HTTPCaching((b, { logger }) => b.store(store).observer(composeObservers(metrics, loggingCacheObserver(logger))))
```

| Method           | When                                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onHit`          | Answered from the store. `revalidated` for a `304`, `stale` for an entry past its `ttl`, `coalesced` for a request served what another's handler run stored.                  |
| `onMiss`         | Nothing to serve: `absent`, `expired`, `stale-for-request`, `only-if-cached` (answered `504`), or `not-coalesced` (waited on a handler run that stored nothing it could use). |
| `onBypass`       | The store was not consulted: `method`, `disabled`, `private`, `authorization`, `authenticated`, `vary-any`, `no-cache`, `no-store`, `max-age-0`, `pragma-no-cache`.           |
| `onStore`        | A response was stored, with its size in bytes and its tags.                                                                                                                   |
| `onSkip`         | A response the policy would have stored, left out: `set-cookie`, `entry-too-large`, or `stream`.                                                                              |
| `onInvalidate`   | An eviction went through, with its tags.                                                                                                                                      |
| `onStaleIfError` | A `5xx` was replaced by a stale entry. The miss was already reported; this is not a second hit.                                                                               |
| `onError`        | A store call rejected or timed out: `get`, `put` or `evict`.                                                                                                                  |

`event.key` holds the query string and the value of every `vary` header, credentials included when a route
varies on one. Do not use it as a metric attribute. `loggingCacheObserver` leaves keys out unless
`includeKeys: true`, writes at `debug` unless `level` says otherwise, and always writes a store failure at
`error`.

Observers cost nothing when absent: no event is built for a route nobody observes.

## Start-up errors

All of these fail `app.ready()` with `ErrConfiguration`:

- a route declares `@CacheControl` or `@CacheInvalidate` and the plugin is not installed for it
- `HTTPCaching` has no `store`, or a `store`, `etagGenerator` or `observer` token is bound to nothing
- `ttl` is below one second, `storeTimeout` or `lockTimeout` is not a positive duration, another duration option
  does not parse (`'10 seconds'`), or `maxEntrySize` is not a byte size
- a tag is not a non-empty string without `{` or `}`, or `@CacheInvalidate` names no tag
- a constrained route has a `ttl` and nothing in its key tells it from the other routes on its URL

## Limits

- One handler run per miss holds in one process. Replicas do not share a lock.
- A `GET` already running when a mutation evicts can store the older response after the eviction. One handler
  run per miss narrows that to one writer per key; keep `ttl` short where it matters.
- A stale entry is served only while a handler run is under way for it (`staleWhileRevalidate`) or once one
  failed (`staleIfError`). Nothing refreshes an entry in the background.
- A `HEAD` that misses stores nothing, and carries no `ETag` when the server dropped its body before the cache saw
  it. A `HEAD` is answered from what a `GET` stored, so a route that only ever receives `HEAD` never fills the
  cache.
- `max-stale` is not read: a route's stale windows are its own choice.
