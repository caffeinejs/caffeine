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
  /** An entry is stored, but it is older than the request's `max-age` allows. */
  | 'stale-for-request'
  /** The store handed back an entry older than the route's `ttl`. */
  | 'expired'
  /** Nothing the request accepts is stored and it said `only-if-cached`, so it was answered `504`. */
  | 'only-if-cached'

export interface CacheBypassEvent {
  readonly route: CacheRoute
  readonly segment?: string
  readonly reason: CacheBypassReason
}

export interface CacheMissEvent {
  readonly route: CacheRoute
  readonly segment?: string
  /**
   * The store key. Unbounded, and carries the request's query string and every `Vary` header value verbatim —
   * credentials included when a route varies on one. Never a metric attribute.
   */
  readonly key: string
  readonly reason: CacheMissReason
}

export interface CacheHitEvent {
  readonly route: CacheRoute
  readonly segment?: string
  /** The store key; see {@link CacheMissEvent.key}. */
  readonly key: string
  /** `true` when the hit was answered `304`, `false` when the stored body was served. */
  readonly revalidated: boolean
  /** Apparent age of the served entry, in whole seconds. `0` when the store did not record `storedAt`. */
  readonly ageSeconds: number
}

export interface CacheStoreEvent {
  readonly route: CacheRoute
  readonly segment?: string
  /** The store key; see {@link CacheMissEvent.key}. */
  readonly key: string
  /** Byte length of the stored payload, headers excluded. */
  readonly bytes: number
  /** The route's `ttl` in seconds, fractional below one second. */
  readonly ttlSeconds: number
}

/**
 * An eviction a successful mutating request performed.
 *
 * `scope: 'keys'` lists the keys eviction was requested for, not the ones that existed — `Cache.deleteMany`
 * reports no count. `scope: 'segment'` cleared the whole segment.
 */
export type CacheInvalidateEvent =
  | {
      readonly route: CacheRoute
      readonly segment?: string
      readonly scope: 'keys'
      /** The store keys; see {@link CacheMissEvent.key}. */
      readonly keys: readonly string[]
    }
  | { readonly route: CacheRoute; readonly segment: string; readonly scope: 'segment' }

/** The store call that failed. `delete` covers an eviction by keys, `clear` one by segment. */
export type CacheOperation = 'get' | 'put' | 'delete' | 'clear'

/**
 * A store call that rejected. The request went on without the cache: a failed `get` was treated as a miss, a
 * failed write or eviction was skipped.
 */
export interface CacheErrorEvent {
  readonly route: CacheRoute
  readonly segment?: string
  readonly operation: CacheOperation
  readonly error: unknown
}

/**
 * Notified of what the HTTP cache did for each request on a route that declares caching.
 *
 * Every method is optional and called synchronously, inside the request's own hook, so whatever the request's
 * async context holds — an active tracing span, for one — is still current. `HTTPCaching` catches a method that
 * throws, logs the first throw from each method on the application logger, and never lets it reach the response.
 *
 * Reports outcomes the cache status header does not carry: a request whose method the route does not cache, and
 * an `only-if-cached` request answered `504`.
 */
export interface CacheObserver {
  onHit?(event: CacheHitEvent): void
  onMiss?(event: CacheMissEvent): void
  onBypass?(event: CacheBypassEvent): void
  onStore?(event: CacheStoreEvent): void
  onInvalidate?(event: CacheInvalidateEvent): void
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
  onInvalidate: true,
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
