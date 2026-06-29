import { configureRoute } from '@caffeinejs/http'

export function RawBody() {
  return (_fn: Function, context: ClassMemberDecoratorContext): void => {
    configureRoute(context, spec => spec.rawBody(true))
  }
}
