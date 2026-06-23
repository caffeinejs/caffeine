import { RouteBuilder, RouterBuilder } from './routing_decorator_spec.js'

const RouterRegistry = new WeakMap<Function, RouterBuilder>()
const RouteRegistry = new WeakMap<object, Map<string | symbol, RouteBuilder>>()

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

export function configureRouter(key: Function, mut: (spec: RouterBuilder) => void) {
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

  mut(cur)
}

export function getRouter(key: Function): RouterBuilder | undefined {
  return RouterRegistry.get(key)
}
