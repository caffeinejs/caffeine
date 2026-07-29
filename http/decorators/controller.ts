import { type Ctor, type Injection, Injectable, Label } from '@caffeinejs/di'
import { Keys } from '@caffeinejs/application'
import { configureRouterAndRegisterRoutes } from './registrar/registrar.js'

export function Controller(path: string, dependencies?: Injection[]) {
  return function (target: Function, context: ClassDecoratorContext): void {
    Injectable(dependencies ?? [])(target as Ctor, context)
    Label(Keys.CONTROLLER)(target, context)

    configureRouterAndRegisterRoutes(context, target, spec => spec.path(path))
  }
}
