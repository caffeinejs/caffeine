import { configureRoute } from './_registrar.js'

export function Status(code: number) {
  return (
    _target: unknown,
    context: ClassMemberDecoratorContext,
  ) => configureRoute(context, spec => spec.statusCode(code))
}
