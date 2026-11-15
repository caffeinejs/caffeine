import type { RouteExtension } from '../core/routing/extension.js'
import { configureRoute } from './registrar/registrar.js'

/**
 * Reads the request body as raw bytes, whatever its content type, held to the route's `bodyLimit` or the server's: a
 * longer body is refused with a 413 before the handler runs. The bytes are a `Buffer` on the Fastify and Node
 * applications, a `Uint8Array` on the fetch application.
 */
export function bodyAsBuffer(): RouteExtension {
  return route => route.bodyAs('buffer')
}

export function BodyAsBuffer() {
  return (_fn: Function, context: ClassMemberDecoratorContext): void => {
    configureRoute(context, bodyAsBuffer())
  }
}
