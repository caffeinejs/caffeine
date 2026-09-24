import type { RouteExtension } from '../routing/extension.js'
import { configureRoute } from './registrar/registrar.js'

/** Reads the request body as a raw `Buffer`, whatever its content type. */
export function bodyAsBuffer(): RouteExtension {
  return route => route.bodyAs('buffer')
}

export function BodyAsBuffer() {
  return (_fn: Function, context: ClassMemberDecoratorContext): void => {
    configureRoute(context, bodyAsBuffer())
  }
}
