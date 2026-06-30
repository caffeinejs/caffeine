import { configureRoute } from '@caffeinejs/http'
import { kBodyBuffer } from './keys/keys.js'

export function BodyAsBuffer() {
  return (_fn: Function, context: ClassMemberDecoratorContext): void => {
    configureRoute(context, spec => spec.extra(kBodyBuffer, true))
  }
}
