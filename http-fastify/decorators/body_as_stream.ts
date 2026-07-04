import { configureRoute } from '@caffeinejs/application'
import { kBodyStream } from './keys/keys.js'

export function BodyAsStream() {
  return (_fn: Function, context: ClassMemberDecoratorContext): void => {
    configureRoute(context, spec => spec.extras(kBodyStream, true))
  }
}
