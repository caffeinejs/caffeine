import type { Flight } from './flight.js'
import type { HTTPCacheEntry } from './store.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the cache read hook once it has served (or 304'd) from the store, so the store hook skips. */
    responseCached: boolean
    /** The store key the cache read hook derived for this request, which the store hook writes under. */
    cacheKey: string | null
    /** The flight this request leads, so its store hook settles it — this one, never a newer flight under the same key. */
    cacheFlight: Flight | null
    /** A stale entry the read hook found within `staleIfError`, for the store hook to replay over a 5xx. */
    cacheStale: HTTPCacheEntry | null
  }
}
