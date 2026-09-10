import { configureRoute, configureRouteGroup, type AnyRouteExtension } from '@caffeinejs/http'

import type { CacheOptions } from './cache.js'
import type { CacheInvalidateOptions } from './cache_invalidate.js'

type ConfigTarget = { config(key: string, value: unknown): unknown }

/**
 * Caches the route's response, or turns caching off for it with `false`.
 *
 * Needs the caching feature installed (`.extend(caching())`); this is the per-route half of it. The
 * decorator form is {@link Cache}.
 */
export function cache(options: CacheOptions | false = {}): AnyRouteExtension {
  return (target: ConfigTarget) => {
    target.config('cache', options)
  }
}

/**
 * Caches responses for a controller or a single route, or turns caching off with `false`.
 *
 * The programmatic form is {@link cache}.
 */
export function Cache(options: CacheOptions | false = {}) {
  return (fn: Function, context: ClassDecoratorContext | ClassMemberDecoratorContext): void => {
    if (context.kind === 'class') {
      configureRouteGroup(context, fn, cache(options))
    } else {
      configureRoute(context, cache(options))
    }
  }
}

/**
 * Evicts cached entries after a successful mutating request. The decorator form is {@link CacheInvalidate}.
 */
export function cacheInvalidate(options: CacheInvalidateOptions = {}): AnyRouteExtension {
  return (target: ConfigTarget) => {
    target.config('cacheInvalidate', options)
  }
}

/**
 * Evicts cached entries after a successful mutating request on the decorated route.
 *
 * The programmatic form is {@link cacheInvalidate}.
 */
export function CacheInvalidate(options: CacheInvalidateOptions = {}) {
  return (_fn: Function, context: ClassMemberDecoratorContext): void => {
    configureRoute(context, cacheInvalidate(options))
  }
}
