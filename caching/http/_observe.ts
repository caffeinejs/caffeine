import type { Logger } from '@caffeinejs/application/logger'
import type { IContext, RouteDefinition } from '@caffeinejs/http'

import { routeMethods } from './_util.js'
import { observerMethods, type CacheObserver, type CacheOperation, type CacheRoute } from './observer.js'

// Read once per route and frozen: the same object reaches every observer on every request to the route. `head`
// names the HEAD route a GET is also served as, which shares the GET's hooks.
export function cacheRouteOf(route: RouteDefinition, head?: 'HEAD'): CacheRoute {
  const method = head ?? routeMethods(route)
  const url = route.url

  // A programmatic group or route may be unnamed.
  const group = route.group.name
  const name = route.route.name

  if (group && typeof name === 'string' && name !== '') {
    return Object.freeze({ method, url, handler: `${group}.${name}` })
  }

  return Object.freeze({ method, url })
}

// The route each request of `route` reports under: the HEAD route the server adds to a GET shares its hooks, and
// reports under its own method.
export function cacheRouteResolver(route: RouteDefinition): (ctx: IContext) => CacheRoute {
  const own = cacheRouteOf(route)
  const head = route.methods.includes('HEAD') ? own : cacheRouteOf(route, 'HEAD')

  return ctx => (ctx.req.method === 'HEAD' ? head : own)
}

// A throw from an observer never reaches the response: the first from each method is logged, the rest are
// dropped so a broken observer cannot flood the log at request rate. Flags live in this closure — one wrapper
// per install — so two applications in one process do not share them.
export function guardObserver(observer: CacheObserver, log: Logger): CacheObserver {
  const guarded: Record<string, (event: unknown) => void> = {}

  for (const method of observerMethods) {
    if (observer[method] === undefined) {
      continue
    }

    let reported = false

    const report = (err: unknown): void => {
      if (reported) {
        return
      }

      reported = true
      log.error({ err }, `Cache observer "${method}" threw; further throws from "${method}" are suppressed`)
    }

    guarded[method] = event => {
      try {
        // An `async` method fits the `void` signature, and its rejection would otherwise have no handler.
        const result = (observer[method] as (this: CacheObserver, event: unknown) => unknown).call(observer, event)
        if (result instanceof Promise) {
          result.catch(report)
        }
      } catch (err) {
        report(err)
      }
    }
  }

  return guarded as CacheObserver
}

const STORE_ERROR_LOG_INTERVAL_MS = 60_000

// What `HTTPCaching` listens with when the application's observer has no `onError`: a store outage has to show
// up somewhere, and at request rate it must not flood the log. It implements `onError` alone, so every other
// call site still short-circuits before building an event.
export function storeErrorLogger(log: Logger): CacheObserver {
  const lastLogged = new Map<CacheOperation, number>()

  return {
    onError(event) {
      const now = Date.now()
      const last = lastLogged.get(event.operation)
      if (last !== undefined && now - last < STORE_ERROR_LOG_INTERVAL_MS) {
        return
      }

      lastLogged.set(event.operation, now)
      log.error(
        { err: event.error, route: event.route, operation: event.operation },
        `Cache store "${event.operation}" failed; the request went on without the cache`,
      )
    },
  }
}
