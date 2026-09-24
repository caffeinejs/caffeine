import type { RouteExtension } from '../routing/extension.js'
import { configureRoute } from './registrar/registrar.js'

/** Hands the handler the request body as a stream, leaving it unparsed. */
export function bodyAsStream(): RouteExtension {
  return route => route.bodyAs('stream')
}

export function BodyAsStream() {
  return (_fn: Function, context: ClassMemberDecoratorContext): void => {
    configureRoute(context, bodyAsStream())
  }
}
