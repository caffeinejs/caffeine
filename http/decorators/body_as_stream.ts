import type { RouteExtension } from '../routing/extension.js'
import { configureRoute } from './registrar/registrar.js'

/**
 * Hands the handler the request body as a stream, leaving it unparsed, held to the route's `bodyLimit` or the
 * server's. A body declaring a longer Content-Length is refused with a 413 before the handler runs; one declaring
 * none fails the stream with a 413 as it passes the limit.
 */
export function bodyAsStream(): RouteExtension {
  return route => route.bodyAs('stream')
}

export function BodyAsStream() {
  return (_fn: Function, context: ClassMemberDecoratorContext): void => {
    configureRoute(context, bodyAsStream())
  }
}
