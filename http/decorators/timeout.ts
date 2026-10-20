import type { Duration } from '@caffeinejs/std/duration'

import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

export function Timeout(timeout: Duration) {
  return defineClassOrMemberDecorator(
    (target, ctx) => configureRouteGroup(ctx, target, spec => spec.timeout(timeout)),
    context => configureRoute(context, spec => spec.timeout(timeout)),
  )
}
