# @caffeinejs/caching

HTTP response caching for a Caffeine web application: a server-side store in front of your handlers, and the
`Cache-Control`, `ETag`, `Last-Modified`, `Vary` and `Age` headers that let browsers and proxies cache too.
Follows RFC 9110 and RFC 9111.

```sh
npm install @caffeinejs/caching
```

| Import                             | What it holds                                                             |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `@caffeinejs/caching`              | The `Cache` store contract: `Cache`, `CacheEntry`, `CachePutItem`         |
| `@caffeinejs/caching/http`         | `HTTPCaching`, `@CacheControl`, `@CacheInvalidate`, `cacheKey`, observers |
| `@caffeinejs/caching/store/memory` | `MemoryCache`, an in-process LRU store                                    |
| `@caffeinejs/caching/store/redis`  | `RedisCache`, for Redis or Valkey, one server or a cluster                |

## Quick start

Two halves: install the plugin once, then say which routes cache. Decorating routes without installing the
plugin fails at `app.ready()`. There is no default store: you pass one.

```ts
import { Controller, Get, Put, createWebApplication } from '@caffeinejs/http'
import { CacheControl, CacheInvalidate, HTTPCaching } from '@caffeinejs/caching/http'
import { MemoryCache } from '@caffeinejs/caching/store/memory'

@Controller('/pets')
class PetsController {
  @CacheControl({ ttl: '5m' })
  @Get('/')
  list() {
    return petStore.all()
  }

  // Evicts what GET /pets stored, once this answers with a 2xx or a 3xx.
  @CacheInvalidate({ paths: ['/pets'] })
  @Put('/:id')
  update() {
    // ...
  }
}

const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryCache())))
await app.run()
```

The first `GET /pets` runs the handler and answers `X-Cache: MISS`. For the next five minutes the same request is
answered from the store with `X-Cache: HIT` and an `Age` header, and the handler does not run.

`@CacheControl` on a class applies to every route of the controller. The same options are available without
decorators, as route extensions:

```ts
import { Router } from '@caffeinejs/http'
import { cacheControl, cacheInvalidate } from '@caffeinejs/caching/http'

const pets = new Router('/pets')
pets
  .get('/')
  .with(cacheControl({ ttl: '5m', segment: 'pets' }))
  .handler(() => petStore.all())
pets
  .post('/')
  .with(cacheInvalidate({ clear: true, segment: 'pets' }))
  .handler(() => ({ created: true }))
```

A duration is a number of seconds or a string such as `'500ms'`, `'30s'`, `'5m'`, `'1h'`, `'1d'`.

## What is cached

A response is stored when all of these hold:

- the route has a `ttl`, and does not say `noStore`
- the request method is in `methods` (default `GET` and `HEAD`) and the status is in `statusCodes` (default `200`)
- the request is not private (see below), and did not say `Cache-Control: no-store`
- the route does not vary on `*`
- the handler did not write its own `Cache-Control` header
- the payload is a string or a `Buffer`, not a stream

A hit replays the stored status code and headers. Connection-specific headers, `Set-Cookie`, `Content-Length`,
`Date`, `Age` and `Access-Control-*` are never stored, so each response gets its own. A header that an earlier hook
already set for the current request is kept over the stored one, and `Vary` is merged, never replaced.

A route with no `ttl` stores nothing. It still sends an `ETag`, so clients can revalidate, and whatever policy it
declared: `@CacheControl({ noCache: true })` sends `Cache-Control: no-cache`, while `@CacheControl()` alone has no
directive to send and sends no `Cache-Control`.

### Private requests

A request is private when the route says `privacy: 'private'`, when it carries an `Authorization` header, or when
an authentication scheme identified the client some other way, a session cookie for one. A private request is
answered `Cache-Control: private`, marked `X-Cache: BYPASS`, and nothing is stored. A route whose response is the
same for everyone opts out with `privacy: 'public'`.

### The handler decides for its own response

A `Cache-Control` header written by the handler is left as written, and that response is not stored. An `ETag`
or `Last-Modified` written by the handler is kept and becomes the stored validator. `@CacheControl(false)` is the
exception: it always writes the full set of no-cache headers.

### Responses the route does not cache

An error, a status outside `statusCodes`, or a method outside `methods` gets nothing permissive from the policy:
no `Cache-Control`, no `ETag`, no `Last-Modified`. A `noStore` route still says `no-store` on those responses.
`Vary` goes on every response of the route.

## Requests

| Request                                                   | Effect                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| `Cache-Control: no-cache`, `max-age=0`                    | Not answered from the store. The fresh response is stored.    |
| `Cache-Control: no-store`                                 | Not answered from the store, and the response is not stored.  |
| `Cache-Control: max-age=N`                                | An entry older than `N` seconds is a miss.                    |
| `Cache-Control: only-if-cached`                           | Answered from the store, or `504` when nothing acceptable is. |
| `Pragma: no-cache`                                        | Read only when the request has no `Cache-Control` header.     |
| `If-None-Match`, `If-Modified-Since` on a `GET` or `HEAD` | `304` when it matches, on a hit and on a miss alike.          |

Directive names are matched case-insensitively. `If-None-Match` wins over `If-Modified-Since` when both are sent.
A `304` answered from the store carries only `Cache-Control`, `Content-Location`, `ETag`, `Expires`,
`Last-Modified` and `Vary`. A `304` on a miss is the handler's own response with the body and `Content-Length`
taken off, so it keeps that response's other headers, `Content-Type` included. A `HEAD` hit carries the
`Content-Length` the `GET` would have.

The status header is `X-Cache` by default, renamed with `.statusHeader(...)`:

| Value    | Meaning                                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------- |
| `HIT`    | Answered from the store, with the stored body or with a `304`.                                                 |
| `MISS`   | The handler ran. The response was stored if it qualified.                                                      |
| `BYPASS` | The store was not consulted: a private request, a request directive, `vary: ['*']`, or `@CacheControl(false)`. |

A request whose method is not in `methods` gets no status header at all: the cache has nothing to say about it.
An observer still hears of it, as `onBypass` with `reason: 'method'`.

## `@CacheControl` options

| Option                                                                     | Meaning                                                                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ttl`                                                                      | How long a response is fresh: the entry's lifetime in the store and the `max-age` sent. Positive. Without it nothing is stored. |
| `sharedMaxAge`                                                             | Sent as `s-maxage`.                                                                                                             |
| `staleWhileRevalidate`, `staleIfError`                                     | Sent for caches downstream. The server-side store never serves a stale entry.                                                   |
| `noStore`                                                                  | Sends `no-store` on every response of the route, errors included, and stores nothing.                                           |
| `noCache`, `mustRevalidate`, `proxyRevalidate`, `noTransform`, `immutable` | The directive of the same name.                                                                                                 |
| `privacy`                                                                  | `'private'` keeps the response out of the store. `'public'` stores it even for an identified client.                            |
| `vary`                                                                     | Request headers the response depends on. Added to `Vary`, and their values become part of the key. `['*']` is never stored.     |
| `etag`                                                                     | `false` sends no generated `ETag`. Storing does not depend on it.                                                               |
| `methods`                                                                  | Methods whose responses are cached. Default `GET`, `HEAD`. Case-insensitive.                                                    |
| `statusCodes`                                                              | Statuses that are cached, and replayed as they were. Default `200`.                                                             |
| `segment`                                                                  | Groups the route's entries so one eviction clears them together.                                                                |
| `key`                                                                      | Derives the store key instead of the default.                                                                                   |
| `etagGenerator`                                                            | Hashes the payload for this route, instead of the one given to `HTTPCaching`.                                                   |

`@CacheControl(false)` turns caching off for a route under a class-level `@CacheControl`, and sends
`Cache-Control: no-store, max-age=0, must-revalidate, proxy-revalidate` with the matching `Expires`, `Pragma` and
`Surrogate-Control`.

Caching an unsafe method is allowed and is yours to get right: the default key never reads the body, so a
`POST` listed in `methods` is answered with whatever the first `POST` to that URL produced, unless `key` tells
the requests apart.

## Keys

The default key is the URL with its query parameters sorted, so `?a=1&b=2` and `?b=2&a=1` share an entry. `GET`
and `HEAD` share a key; any other method is part of it. With `vary`, the value of each listed request header is
appended, which gives one entry per combination.

Routes selected by a constraint, a version or a host, share their URL with the routes selected otherwise, and so
would share a key. Such a route with a `ttl` must list the constraint's header in `vary`, or have its own
`segment`, or its own `key`. Otherwise `app.ready()` fails. Give each version its own segment: two versions that
declare the same one still collide.

```ts
@CacheControl({ ttl: 60, vary: ['Accept-Version'] })
```

## Invalidation

`@CacheInvalidate` evicts after the decorated route answers with a `2xx` or a `3xx`, so a form post answered
with a redirect evicts as well. It has three forms, never mixed:

```ts
// 1. Paths: literal, not patterns. Without `paths`, the request's own URL.
@CacheInvalidate({ paths: ['/pets', '/pets/featured'] })

// 2. Keys: used exactly as returned. Reaches what this stored: @CacheControl({ ttl: '5m', key: petKey })
const petKey = (req: FastifyContextRequest) => `pet:${req.param('id')}`
@CacheInvalidate({ key: petKey })

// 3. A whole segment. The only form that reaches every variant of a route that varies.
@CacheInvalidate({ clear: true, segment: 'pets' })
```

`segment` must be the one the `@CacheControl` stored under. `clear` without a `segment` fails at `app.ready()`.

An eviction reaches an entry only under the exact key it was stored with. Nothing checks this for you:

- A route cached under its own `key` function is evicted with that same function, not with `paths`.
- A route that varies keeps one entry per header combination, and a path names none of them. Put it in a
  `segment` and clear that.
- For the default key, `cacheKey` derives it from the evicting request:

```ts
import { CacheInvalidate, cacheKey } from '@caffeinejs/caching/http'

// PUT /pets/:id evicts what GET /pets/:id and GET /pets stored
@CacheInvalidate({
  key: req => [cacheKey(req, { method: 'GET' }), cacheKey(req, { method: 'GET', url: '/pets' })],
})
```

| `cacheKey` option | Used instead of                                                            |
| ----------------- | -------------------------------------------------------------------------- |
| `method`          | The request's method.                                                      |
| `url`             | The request's URL, query included.                                         |
| `vary`            | Nothing: the header names the cached route varies on.                      |
| `headers`         | The request's header values, by lower-cased name, for the names in `vary`. |

## Installing

`HTTPCaching` takes an options object or a builder callback. The callback's second argument is the setup
context, with the `container` and the application `logger`.

```ts
.with(
  HTTPCaching((b, { logger }) =>
    b
      .store(new MemoryCache({ max: 1_000, maxSize: '64MB' }))
      .statusHeader('X-Cache')
      .observer(loggingCacheObserver(logger)),
  ),
)
```

`store`, `etagGenerator` and `observer` each take the value or a container token. A token bound to nothing fails
at `app.ready()`, and so does a missing `store`. Nothing is bound into the container for you.

It installs on the whole application, or on one route group with `router.plugin(HTTPCaching(...))` or
`@Use(HTTPCaching(...))`, each install with its own store and settings. A group that declares caching and
installs nothing, under an application that installs nothing, fails at `app.ready()`.

Order matters in two places:

- Install it after `.authentication(...)`. Guards run before the cache, on a hit as well as on a miss, so a
  cached response never skips authorization.
- Install it before a plugin that compresses responses. Installed after one, the cache is handed a stream, which
  is neither hashed nor stored, and says nothing about it.

The default `ETag` is a strong tag hashed from the payload before any content-coding. Behind a compressor, the
one tag goes out with every coding; if that matters, pass an `etagGenerator` that returns weak tags (`W/"..."`).

## Stores

### `MemoryCache`

An LRU in the process. `max` caps the number of entries (default 500); `maxSize` caps the summed bytes of
payloads and headers (`'512kb'`, `'64MB'`, or a number of bytes). It also takes a pre-built `LRUCache` for the
settings those two do not cover. Each replica has its own, so an eviction on one replica does not reach the
others.

### `RedisCache`

For Redis 8.0 or later, or Valkey 9.0 or later: entries are written with `HSETEX`, and an older server rejects
every write, which shows as a store failure in the log and a cache that never fills. Needs `@redis/client`, an
optional peer that is loaded only when you import this path.

```ts
import { createClient } from '@redis/client'
import { RedisCache } from '@caffeinejs/caching/store/redis'

const client = createClient({ url: process.env.REDIS_URL })
await client.connect()

const store = new RedisCache(client, { prefix: 'myapp:cache:' })
```

- The client is yours. The store never connects, closes or reconnects it. A client from `createClient()` and
  one from `createCluster()` both fit.
- An entry is one hash, with the payload stored as the bytes it was given.
- `clear(segment)` costs one `INCR`, whatever the segment holds. `clear()` without a segment rejects.
- It never sends `SCAN`, `KEYS`, `FLUSHDB`, `FLUSHALL`, a script, or a command naming two keys, so it is safe on a
  cluster and on a shared server.
- On a cluster, keys spread over the shards one by one. `hashTag: segment => ...` gathers them: return a tag to
  keep a segment on one shard, or the same tag for several segments to keep those together.
- Run the server with `noeviction` or a `volatile-*` policy. Under `allkeys-*` the server may evict a segment's
  counter, and entries cleared earlier can become readable again until their own `ttl`.
- `prefix` and hash tags may not contain `{` or `}`: `ErrRedisCache`.

### Your own

Implement `Cache` from `@caffeinejs/caching`:

```ts
interface Cache {
  get(key: string, segment?: string): Promise<CacheEntry | undefined>
  getMany(keys: string[], segment?: string): Promise<(CacheEntry | undefined)[]>
  put(key: string, entry: CacheEntry, ttl: Duration, segment?: string): Promise<void>
  putMany(items: CachePutItem[], segment?: string): Promise<void>
  delete(key: string, segment?: string): Promise<void>
  deleteMany(keys: string[], segment?: string): Promise<void>
  clear(segment?: string): Promise<void>
}
```

- An entry past its `ttl` reads as `undefined`. A `ttl` that is not positive stores nothing.
- `getMany` returns one slot per key, in order, duplicates included.
- Each `putMany` item carries its own `ttl`. It is not atomic.
- A `Buffer` payload comes back a `Buffer`, byte for byte; a string comes back a string.
- Segments are separate namespaces: a segment name must not reach into another, or into keys stored without one.
- `clear()` without a segment may be refused. The HTTP cache never calls it.

## When the store fails

A store that rejects never fails a request. A failed `get` is a miss, a failed `put` or eviction is skipped, and
the response the handler produced goes out unchanged. Each failure goes to `observer.onError`. Without an observer
listening for it, the failure is logged on the application logger, at most once a minute for each operation.

## Observing

A `CacheObserver` is told of every outcome. Every method is optional, and an observer that throws never reaches
the response.

```ts
import { composeObservers, loggingCacheObserver, type CacheObserver } from '@caffeinejs/caching/http'

const metrics: CacheObserver = {
  onHit: e => hits.add(1, { route: e.route.url, revalidated: e.revalidated }),
  onMiss: e => misses.add(1, { route: e.route.url, reason: e.reason }),
  onError: e => storeErrors.add(1, { operation: e.operation }),
}

HTTPCaching((b, { logger }) => b.store(store).observer(composeObservers(metrics, loggingCacheObserver(logger))))
```

| Method         | When                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onHit`        | Answered from the store. `revalidated` is `true` for a `304`.                                                                                                       |
| `onMiss`       | Nothing to serve: `absent`, `expired`, `stale-for-request`, or `only-if-cached` (answered `504`).                                                                   |
| `onBypass`     | The store was not consulted: `method`, `disabled`, `private`, `authorization`, `authenticated`, `vary-any`, `no-cache`, `no-store`, `max-age-0`, `pragma-no-cache`. |
| `onStore`      | A response was stored, with its size in bytes.                                                                                                                      |
| `onInvalidate` | An eviction went through, by keys or by segment.                                                                                                                    |
| `onError`      | A store call rejected: `get`, `put`, `delete` or `clear`.                                                                                                           |

`event.key` holds the query string and the value of every `vary` header, credentials included when a route
varies on one. Do not use it as a metric attribute. `loggingCacheObserver` leaves keys out unless
`includeKeys: true`, writes at `debug` unless `level` says otherwise, and always writes a store failure at
`error`.

Observers cost nothing when absent: no event is built for a route nobody observes.

## Start-up errors

All of these fail `app.ready()` with `ErrConfiguration`:

- a route declares `@CacheControl` or `@CacheInvalidate` and the plugin is not installed for it
- `HTTPCaching` has no `store`, or a `store`, `etagGenerator` or `observer` token is bound to nothing
- `ttl` is not a positive duration, or another duration option does not parse (`'10 seconds'`)
- a constrained route has a `ttl` and nothing in its key tells it from the other routes on its URL
- `@CacheInvalidate` mixes forms, or says `clear` without a `segment`

## Limits

- The server-side store never serves a stale entry. `staleWhileRevalidate` and `staleIfError` are for caches
  downstream.
- No stampede protection yet: concurrent misses for one key each run the handler.
- A `GET` already running when a mutation evicts can store the older response after the eviction. Keep `ttl`
  short where that matters.
- A `HEAD` that misses stores nothing and carries no `ETag`: the server drops the body of a `HEAD` before the
  cache sees it. A `HEAD` is answered from what a `GET` stored, so a route that only ever receives `HEAD` never
  fills the cache.
