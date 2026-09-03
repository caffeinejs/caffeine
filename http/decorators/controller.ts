import { type Ctor, type InjectionsFor, Injectable, Label } from '@caffeinejs/di'

import { Keys } from '../symbols.js'
import { configureRouteGroupAndRegisterRoutes } from './registrar/registrar.js'

export function Controller<A extends unknown[] = []>(
  path: string,
  dependencies?: [...InjectionsFor<A>],
): (target: Ctor<unknown, A>, context: ClassDecoratorContext) => void {
  return function (target: Ctor<unknown, A>, context: ClassDecoratorContext): void {
    if (dependencies === undefined) {
      Injectable()(target as Ctor<unknown, []>, context)
    } else {
      Injectable(dependencies)(target, context)
    }
    Label(Keys.CONTROLLER)(target, context)

    configureRouteGroupAndRegisterRoutes(context, target, spec => spec.path(path))
  }
}
