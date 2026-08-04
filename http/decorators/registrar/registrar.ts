import type { Ctor } from '@caffeinejs/di'
import { RouteBuilder, RouterBuilder } from './routing.js'

const RouterRegistry = new WeakMap<Function, RouterBuilder>()
const RouteRegistry = new WeakMap<object, Map<string | symbol, RouteBuilder>>()
const ControllerErrorHandlerRegistry = new WeakMap<object, Array<[Ctor<Error>, string | symbol]>>()

// Registers a controller method as the handler for a given error type. Duplicate detection is
// deferred to build (buildRouting) — throwing here would run at class-decoration time and break
// module import.
export function configureControllerErrorHandler(ctx: ClassMethodDecoratorContext, error: Ctor<Error>) {
  let list = ControllerErrorHandlerRegistry.get(ctx.metadata)
  if (!list) {
    list = []
    ControllerErrorHandlerRegistry.set(ctx.metadata, list)
  }

  list.push([error, ctx.name])
}

export function configureRoute(ctx: ClassMemberDecoratorContext, mut: (spec: RouteBuilder) => void) {
  let routes = RouteRegistry.get(ctx.metadata)
  if (!routes) {
    routes = new Map<string | symbol, RouteBuilder>()
    RouteRegistry.set(ctx.metadata, routes)
  }

  let route = routes.get(ctx.name)
  if (!route) {
    route = new RouteBuilder()
    routes.set(ctx.name, route)
  }

  mut(route)
}

export function configureRouter(
  _ctx: ClassDecoratorContext,
  key: Function,
  mut: (spec: RouterBuilder) => void,
): void {
  let cur = RouterRegistry.get(key)
  if (!cur) {
    cur = new RouterBuilder()
    RouterRegistry.set(key, cur)
  }

  mut(cur)
}

export function configureRouterAndRegisterRoutes(
  ctx: ClassDecoratorContext,
  key: Function,
  mut: (spec: RouterBuilder) => void,
): void {
  let cur = RouterRegistry.get(key)
  if (!cur) {
    cur = new RouterBuilder()
    RouterRegistry.set(key, cur)
  }

  cur.routes(Array.from(RouteRegistry.get(ctx.metadata)?.values() ?? []) as RouteBuilder[])

  const errorHandlers = ControllerErrorHandlerRegistry.get(ctx.metadata)
  if (errorHandlers?.length) {
    cur.errorHandlers(errorHandlers)
  }

  mut(cur)
}

export function getRouter(key: Function): RouterBuilder | undefined {
  return RouterRegistry.get(key)
}
