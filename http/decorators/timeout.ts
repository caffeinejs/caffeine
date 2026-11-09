import type { Duration } from '@caffeinejs/std/duration'

import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

/**
 * Answers a request 503 once `timeout` passes without an answer, timed from the request's arrival, so it covers its
 * hooks and its body. On a class, it times every route of the controller. The request's signal aborts with the
 * timeout as its reason.
 */
export function Timeout(timeout: Duration) {
  return defineClassOrMemberDecorator(
    (target, ctx) => configureRouteGroup(ctx, target, spec => spec.timeout(timeout)),
    context => configureRoute(context, spec => spec.timeout(timeout)),
  )
}
