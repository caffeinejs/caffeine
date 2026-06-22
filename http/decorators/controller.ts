import { Ctor, Injection } from '@caffeine-projects/dicaf'
import { Injectable, Label } from '@caffeine-projects/dicaf/decorators'
import { Keys } from '../symbols.js'
import { configureRouterAndRegisterRoutes } from './_registrar.js'

export function Controller(prefix: string, dependencies?: Injection[]) {
  return function (target: Function, context: ClassDecoratorContext): void {
    Injectable(dependencies ?? [])(target as Ctor, context)
    Label(Keys.CONTROLLER)(target, context)

    configureRouterAndRegisterRoutes(context, target, spec => spec.prefix(prefix))
  }
}
