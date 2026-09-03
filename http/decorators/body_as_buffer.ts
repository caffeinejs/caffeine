import type { RouteExtension } from '../routing/programmatic/extension.js'
import { kBodyBuffer } from './keys/keys.js'
import { configureRoute } from './registrar/registrar.js'

/** Reads the request body as a raw `Buffer`, whatever its content type. */
export function bodyAsBuffer(): RouteExtension {
  return route => route.extras(kBodyBuffer, true)
}

export function BodyAsBuffer() {
  return (_fn: Function, context: ClassMemberDecoratorContext): void => {
    configureRoute(context, bodyAsBuffer())
  }
}
