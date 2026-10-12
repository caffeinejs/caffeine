import { boundTo, kBindTo } from '../../binding.js'
import { stateOf } from './_state.js'
import { Router } from './router.js'

type AnyRouter = Router<any, any, any, any, any, any>

/**
 * The routers a plugin factory on the ops server `server` mounts, as the application mounts them: one that names no
 * server is nested in a router bound to `server`, and one that names a server is left to its binding.
 *
 * Nested rather than labelled, so the router itself is left as it was: one router two servers' factories mount is
 * served on both. The router it is nested in declares no route, so it adds no group of its own.
 */
export function servedOn(server: string, routers: readonly AnyRouter[]): AnyRouter[] {
  return routers.map(router =>
    boundTo(stateOf(router)?.builder.toRouteGroup().labels) === undefined
      ? new Router()
          .with(group => {
            group.label(kBindTo, server)
          })
          .mount(router)
      : router,
  )
}
