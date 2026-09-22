/** A route's cache identity, built once when the route registers and shared, frozen, by every event it emits. */
export interface CacheRoute {
  /** The methods the route registered under, joined with `|`: `GET`, `HEAD`, `GET|POST`. */
  readonly method: string
  /** The registered path pattern, prefix included — `/api/pets/:id`, never the request URL. */
  readonly url: string
  /** `PetsController.findOne`. Absent on a route registered straight on Fastify, or on an unnamed group or route. */
  readonly handler?: string
}

/** Why a request on a cached route did not consult the cache. */
export type CacheBypassReason =
  /** The request method is not one of the route's cacheable `methods`. */
  | 'method'
  /** The route declared `@CacheControl(false)`. */
  | 'disabled'
  /** The route declared `privacy: 'private'`. */
  | 'private'
  /** The request carried `Authorization` and the route did not declare itself public. */
  | 'authorization'
  /** The request was authenticated by other means, a session cookie for one, and the route did not declare itself public. */
  | 'authenticated'
  /** The route varies on `*`, which no stored response can match. */
  | 'vary-any'
  | 'no-cache'
  | 'no-store'
  | 'max-age-0'
  | 'pragma-no-cache'

/** Why the cache had no response to serve. */
export type CacheMissReason =
  /** Nothing is stored under the key. */
  | 'absent'
  /** An entry is stored, but it is older than the request's `max-age` allows, or fresher for less than its `min-fresh` asks. */
  | 'stale-for-request'

  /** The store handed back an entry older than the route's `ttl`. */
  | 'expired'
  /** Nothing the request accepts is stored and it said `only-if-cached`, so it was answered `504`. */
  | 'only-if-cached'
  /** The request waited on another's handler run, which stored nothing it could use, so it ran the handler itself. */
  | 'not-coalesced'

/** Why a response the policy would have stored was left out. */
export type CacheSkipReason =
  /** The response set a cookie and the route did not declare itself public. */
  | 'set-cookie'
  /** The payload is larger than `maxEntrySize`. */
  | 'entry-too-large'
  /** The payload is a stream, which is neither hashed nor stored. */
  | 'stream'
  /** The response has no body: nothing to hash, nothing to replay. */
  | 'empty'

export interface CacheBypassEvent {
  readonly route: CacheRoute
  readonly reason: CacheBypassReason
}

export interface CacheMissEvent {
  readonly route: CacheRoute
  /**
   * The store key. Unbounded, and carries the request's query string and every `Vary` header value verbatim —
   * credentials included when a route varies on one. Never a metric attribute.
   */
  readonly key: string
  readonly reason: CacheMissReason
}

export interface CacheHitEvent {
  readonly route: CacheRoute
  /** The store key; see {@link CacheMissEvent.key}. */
  readonly key: string
  /** `true` when the hit was answered `304`, `false` when the stored body was served. */
  readonly revalidated: boolean
  /** Apparent age of the served entry, in whole seconds. `0` when the store did not record `storedAt`. */
  readonly ageSeconds: number
  /** `true` when the request waited on another's handler run and was served what it stored. */
  readonly coalesced: boolean
  /** `true` when the entry was past the route's `ttl` and served under `staleWhileRevalidate` or `staleIfError`. */
  readonly stale: boolean
}

/** A `5xx` the handler produced, replaced by a stale entry under `staleIfError`. Nothing was stored. */
export interface CacheStaleIfErrorEvent {
  readonly route: CacheRoute
  /** The store key; see {@link CacheMissEvent.key}. */
  readonly key: string
  /** Apparent age of the entry served, in whole seconds. */
  readonly ageSeconds: number
  /** The status the handler answered with. */
  readonly replaced: number
}

export interface CacheStoreEvent {
  readonly route: CacheRoute
  /** The store key; see {@link CacheMissEvent.key}. */
  readonly key: string
  /** Byte length of the stored payload, headers excluded. */
  readonly bytes: number
  /** The route's `ttl` in seconds, fractional above one second. */

  readonly ttlSeconds: number
  /** The tags the entry was stored under, when the route declares any. */
  readonly tags?: readonly string[]
}

/** A response the policy would have stored, left out. Nothing reached the store. */
export interface CacheSkipEvent {
  readonly route: CacheRoute
  /** The store key; see {@link CacheMissEvent.key}. */
  readonly key: string
  readonly reason: CacheSkipReason
  /** Byte length of the payload that was not stored. Absent for a stream. */
  readonly bytes?: number
}

/** An eviction a successful mutating request performed: every entry under any of `tags`, from any route. */
export interface CacheInvalidateEvent {
  readonly route: CacheRoute
  readonly tags: readonly string[]
}

/** The store call that failed. `evict` is an eviction by tags. */
export type CacheOperation = 'get' | 'put' | 'evict'

/**
 * A store call that rejected, or was given up on after `storeTimeout`. The request went on without the cache:
 * a failed `get` was treated as a miss, a failed write or eviction was skipped.
 */
export interface CacheErrorEvent {
  readonly route: CacheRoute
  readonly operation: CacheOperation
  readonly error: unknown
}

/**
 * Notified of what the HTTP cache did for each request on a route that declares caching.
 *
 * Every method is optional and called synchronously, inside the request's own hook, so whatever the request's
 * async context holds — an active tracing span, for one — is still current. `HTTPCaching` catches a method that
 * throws, or whose returned promise rejects, logs the first from each method on the application logger, and never
 * lets it reach the response. A returned promise is not awaited.
 *
 * Reports outcomes the cache status header does not carry: a request whose method the route does not cache, an
 * `only-if-cached` request answered `504`, a response left out of the store.
 */
export interface CacheObserver {
  onHit?(event: CacheHitEvent): void
  onMiss?(event: CacheMissEvent): void
  onBypass?(event: CacheBypassEvent): void
  onStore?(event: CacheStoreEvent): void
  onSkip?(event: CacheSkipEvent): void
  onInvalidate?(event: CacheInvalidateEvent): void
  /** A miss already reported, whose `5xx` a stale entry then replaced. Not a second hit. */
  onStaleIfError?(event: CacheStaleIfErrorEvent): void
  /**
   * Without one, `HTTPCaching` logs store failures itself, on the application logger, at most once a minute for
   * each operation.
   */
  onError?(event: CacheErrorEvent): void
}

// Written as a `Record` over the interface's keys, so a method added to `CacheObserver` and not here fails to
// compile instead of being silently dropped by whatever iterates this list.
const methods: Record<keyof CacheObserver, true> = {
  onHit: true,
  onMiss: true,
  onBypass: true,
  onStore: true,
  onSkip: true,
  onInvalidate: true,
  onStaleIfError: true,
  onError: true,
}

/** Every {@link CacheObserver} method name. */
export const observerMethods = Object.keys(methods) as readonly (keyof CacheObserver)[]

/**
 * Fans each event out to `observers`, in argument order.
 *
 * The result has a method only where at least one observer implements it, read when this is called. Each
 * observer is called as a method, so a class-based one keeps its `this`. A throwing observer stops the fan-out
 * to the ones after it.
 */
export function composeObservers(...observers: readonly CacheObserver[]): CacheObserver {
  const composed: Record<string, (event: unknown) => void> = {}

  for (const method of observerMethods) {
    const members = observers.filter(observer => observer[method] !== undefined)
    if (members.length === 0) {
      continue
    }

    composed[method] = event => {
      for (const member of members) {
        ;(member[method] as (this: CacheObserver, event: unknown) => void).call(member, event)
      }
    }
  }

  return composed as CacheObserver
}
