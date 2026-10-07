import { csrfExempt } from '../csrf/route.js'
import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

/**
 * Leaves a route, or every route of a controller, out of cross-origin protection: a webhook receiver, a form a
 * partner's site posts here.
 *
 * On a controller it exempts every method; on a method it exempts that method whatever the controller declared. The
 * programmatic form is {@link csrfExempt}.
 */
export function CSRFExempt() {
  return defineClassOrMemberDecorator(
    (target, context) => configureRouteGroup(context, target, csrfExempt()),
    context => configureRoute(context, csrfExempt()),
  )
}
