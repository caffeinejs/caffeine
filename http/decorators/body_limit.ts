import type { ByteSize } from '@caffeinejs/std/bytes'

import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

/**
 * Caps the request body size of a route, or of every route in a controller.
 *
 * Takes a count of bytes, written with the constants: `@BodyLimit(10 * MiB)`, or `@BodyLimit(bytes('10mb'))` for text.
 */
export function BodyLimit(limit: ByteSize) {
  return defineClassOrMemberDecorator(
    (target, ctx) => configureRouteGroup(ctx, target, spec => spec.bodyLimit(limit)),
    context => configureRoute(context, spec => spec.bodyLimit(limit)),
  )
}
