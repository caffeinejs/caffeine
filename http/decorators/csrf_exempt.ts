import { csrfExempt } from '../csrf/route.js'
import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

/**
 * Leaves a route, or every route of a controller, out of cross-origin protection: a webhook receiver, a form a
 * partner's site posts here.
 *
 * On a controller it exempts every method, one added later included; on a method it decides for that method whatever
 * the controller declared. `@CSRFExempt(false)` keeps a method protected in an exempt controller, and under a path
 * `exclude(...)` leaves alone. The programmatic form is {@link csrfExempt}.
 */
export function CSRFExempt(exempt = true) {
  return defineClassOrMemberDecorator(
    (target, context) => configureRouteGroup(context, target, csrfExempt(exempt)),
    context => configureRoute(context, csrfExempt(exempt)),
  )
}
