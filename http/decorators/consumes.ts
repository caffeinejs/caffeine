import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouter } from './_registrar.js'

export function Consumes(consumes: string | string[]) {
  defineClassOrMemberDecorator(
    (target) => configureRouter(target, spec => spec.consumes(consumes))
    , (context) => configureRoute(context, spec => spec.consumes(consumes))
  )
}
