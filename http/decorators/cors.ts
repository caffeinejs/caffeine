import { cors, type CORSConfig } from '../core/cors/cors.js'
import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

/**
 * Sets a route's CORS settings, or every route's of a controller, over `corsPolicy()`'s, member by member; `false`
 * turns CORS off for the route and its preflight.
 *
 * On a controller it sets every method, one added later included; on a method it decides for that method whatever the
 * controller declared. The programmatic form is {@link cors}.
 */
export function CORS(options: CORSConfig | boolean) {
  return defineClassOrMemberDecorator(
    (target, context) => configureRouteGroup(context, target, cors(options)),
    context => configureRoute(context, cors(options)),
  )
}
