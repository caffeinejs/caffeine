import type { LogLevel, Logger } from '@caffeinejs/std/logger'

import type { CacheObserver } from './observer.js'

export interface LoggingCacheObserverOptions {
  /** The level every outcome is written at. Defaults to `debug`. A store failure is always written at `error`. */
  level?: LogLevel
  /**
   * Adds `key` / `keys` to the records. Off by default: a key carries the request's query string and `Vary`
   * header values, credentials included when a route varies on one.
   */
  includeKeys?: boolean
}

/**
 * A {@link CacheObserver} writing one record per cache outcome to `log`.
 *
 * The event's fields are the record's fields, so they arrive structured rather than folded into the message.
 * Records leave the cache key out unless `includeKeys` is set; an invalidation carries `keyCount` instead.
 */
export function loggingCacheObserver(log: Logger, options?: LoggingCacheObserverOptions): CacheObserver {
  const level = options?.level ?? 'debug'
  const includeKeys = options?.includeKeys === true

  return {
    onHit(event) {
      log[level](
        {
          route: event.route,
          segment: event.segment,
          revalidated: event.revalidated,
          ageSeconds: event.ageSeconds,
          ...(includeKeys && { key: event.key }),
        },
        'cache hit',
      )
    },

    onMiss(event) {
      log[level](
        { route: event.route, segment: event.segment, reason: event.reason, ...(includeKeys && { key: event.key }) },
        'cache miss',
      )
    },

    onBypass(event) {
      log[level]({ route: event.route, segment: event.segment, reason: event.reason }, 'cache bypass')
    },

    onStore(event) {
      log[level](
        {
          route: event.route,
          segment: event.segment,
          bytes: event.bytes,
          ttlSeconds: event.ttlSeconds,
          ...(includeKeys && { key: event.key }),
        },
        'cache store',
      )
    },

    onInvalidate(event) {
      if (event.scope === 'segment') {
        log[level]({ route: event.route, segment: event.segment, scope: event.scope }, 'cache invalidate')
        return
      }

      log[level](
        {
          route: event.route,
          segment: event.segment,
          scope: event.scope,
          keyCount: event.keys.length,
          ...(includeKeys && { keys: event.keys }),
        },
        'cache invalidate',
      )
    },

    onError(event) {
      log.error(
        { route: event.route, segment: event.segment, operation: event.operation, err: event.error },
        'cache store error',
      )
    },
  }
}
