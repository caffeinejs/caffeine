import type { LogLevel, Logger } from '@caffeinejs/std/logger'

import type { CacheObserver } from './observer.js'

export interface LoggingCacheObserverOptions {
  /** The level every outcome is written at. Defaults to `debug`. A store failure is always written at `error`. */
  level?: LogLevel
  /**
   * Adds `key` to the records. Off by default: a key carries the request's query string and `Vary` header
   * values, credentials included when a route varies on one.
   */
  includeKeys?: boolean
}

/**
 * A {@link CacheObserver} writing one record per cache outcome to `log`.
 *
 * The event's fields are the record's fields, so they arrive structured rather than folded into the message.
 * Records leave the cache key out unless `includeKeys` is set.
 */
export function loggingCacheObserver(log: Logger, options?: LoggingCacheObserverOptions): CacheObserver {
  const level = options?.level ?? 'debug'
  const includeKeys = options?.includeKeys === true

  return {
    onHit(event) {
      log[level](
        {
          route: event.route,
          revalidated: event.revalidated,
          ageSeconds: event.ageSeconds,
          coalesced: event.coalesced,
          stale: event.stale,
          ...(includeKeys && { key: event.key }),
        },
        'cache hit',
      )
    },

    onMiss(event) {
      log[level]({ route: event.route, reason: event.reason, ...(includeKeys && { key: event.key }) }, 'cache miss')
    },

    onBypass(event) {
      log[level]({ route: event.route, reason: event.reason }, 'cache bypass')
    },

    onStore(event) {
      log[level](
        {
          route: event.route,
          bytes: event.bytes,
          ttlSeconds: event.ttlSeconds,
          tags: event.tags,
          ...(includeKeys && { key: event.key }),
        },
        'cache store',
      )
    },

    onSkip(event) {
      log[level](
        { route: event.route, reason: event.reason, bytes: event.bytes, ...(includeKeys && { key: event.key }) },
        'cache skip',
      )
    },

    onInvalidate(event) {
      log[level]({ route: event.route, tags: event.tags }, 'cache invalidate')
    },

    onStaleIfError(event) {
      log[level](
        {
          route: event.route,
          ageSeconds: event.ageSeconds,
          replaced: event.replaced,
          ...(includeKeys && { key: event.key }),
        },
        'cache stale-if-error',
      )
    },

    onError(event) {
      log.error({ route: event.route, operation: event.operation, err: event.error }, 'cache store error')
    },
  }
}
