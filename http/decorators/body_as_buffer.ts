import { configureRoute } from '@caffeinejs/application'
import { kBodyBuffer } from './keys/keys.js'

export function BodyAsBuffer() {
  return (_fn: Function, context: ClassMemberDecoratorContext): void => {
    configureRoute(context, spec => spec.extras(kBodyBuffer, true))
  }
}
