import type { RouteExtension } from '../routing/programmatic/extension.js'
import { configureRoute } from './registrar/registrar.js'
import { kBodyStream } from './keys/keys.js'

/** Hands the handler the request body as a stream, leaving it unparsed. */
export function bodyAsStream(): RouteExtension {
  return route => route.extras(kBodyStream, true)
}

export function BodyAsStream() {
  return (_fn: Function, context: ClassMemberDecoratorContext): void => {
    configureRoute(context, bodyAsStream())
  }
}
