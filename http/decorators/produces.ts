import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRouter, configureRoute } from './registrar/registrar.js'

export function Produces(produces: string | string[]) {
  defineClassOrMemberDecorator(
    target => configureRouter(target, spec => spec.produces(produces)),
    context => configureRoute(context, spec => spec.produces(produces)),
  )
}
