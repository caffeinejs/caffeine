import { cors, type CORSConfig } from '../core/cors/cors.js'
import { RouteOptions } from '../core/routing/options.js'

/**
 * Sets a route's CORS settings, or every route's of a controller, over `corsPolicy()`'s, member by member; `false`
 * turns CORS off for the route's answers. A preflight is answered from the route it lands on, so these set a preflight
 * only where they cover that `OPTIONS` route: a route that serves `OPTIONS`, or a controller whose policy's `OPTIONS`
 * routes inherit them.
 *
 * On a controller it sets every method, one added later included; on a method it decides for that method whatever the
 * controller declared. The programmatic form is {@link cors}.
 */
export function CORS(options: CORSConfig | boolean) {
  return RouteOptions(cors(options))
}
