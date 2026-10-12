import { boundTo, kBindTo } from '../../binding.js'
import { stateOf, type RouterState } from './_state.js'
import { Router } from './router.js'

type AnyRouter = Router<any, any, any, any, any, any>

/**
 * What was mounted on the ops server `server`, as its routing pass declares it: each router once, in mount order.
 * One that names no server is nested in a router bound to `server`; one that names a server is left as it is, for the
 * pass to refuse when that server is another.
 *
 * Nested rather than labelled, so the router itself is left as it was: one router two servers' factories mount is
 * served on both. The router it is nested in declares no route, so it adds no group of its own.
 */
export function servedOn(server: string, routers: readonly AnyRouter[]): AnyRouter[] {
  const seen = new Set<RouterState | undefined>()
  const once = routers.filter(router => {
    const state = stateOf(router)
    if (seen.has(state)) {
      return false
    }

    seen.add(state)
    return true
  })

  return once.map(router =>
    boundTo(stateOf(router)?.builder.toRouteGroup().labels) === undefined
      ? new Router()
          .with(group => {
            group.label(kBindTo, server)
          })
          .mount(router)
      : router,
  )
}
