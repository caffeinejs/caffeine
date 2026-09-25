import { bytes, type ByteSize } from '@caffeinejs/std/bytes'

import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

/**
 * Caps the request body size of a route, or of every route in a controller.
 *
 * Takes a count of bytes or a size string such as `'512kb'` or `'10mb'`; every unit is binary, so `'1kb'` is 1024.
 * @throws `ErrInvalidByteSize` when the size is not a valid byte size.
 */
export function BodyLimit(limit: ByteSize) {
  const size = bytes(limit)

  return defineClassOrMemberDecorator(
    (target, ctx) => configureRouteGroup(ctx, target, spec => spec.bodyLimit(size)),
    context => configureRoute(context, spec => spec.bodyLimit(size)),
  )
}
