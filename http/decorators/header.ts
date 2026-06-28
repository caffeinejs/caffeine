import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouter } from './registrar/registrar.js'

export function Header(name: string, value: string | string[]) {
  return defineClassOrMemberDecorator(
    (target, ctx) => configureRouter(ctx, target, spec => spec.header(name, value)),
    context => configureRoute(context, spec => spec.header(name, value)),
  )
}
