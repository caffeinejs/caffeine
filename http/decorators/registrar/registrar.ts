import type { Ctor } from '@caffeinejs/di'

import type { RequestHookName } from '../../core/lifecycle/lifecycle.js'
import { RouteBuilder, RouteGroupBuilder } from '../../core/routing/builder.js'

const RouteGroupRegistry = new WeakMap<Function, RouteGroupBuilder>()
const RouteRegistry = new WeakMap<object, Map<string | symbol, RouteBuilder>>()
const ControllerErrorHandlerRegistry = new WeakMap<object, Array<[Ctor<Error>, string | symbol]>>()
const ControllerHookRegistry = new WeakMap<object, Array<[RequestHookName, string | symbol]>>()

// Registers a controller method as the handler for the given error types. Duplicate detection is
// deferred to build (buildRouting) — throwing here would run at class-decoration time and break
// module import.
export function configureControllerErrorHandler(ctx: ClassMethodDecoratorContext, errors: Ctor<Error>[]) {
  let list = ControllerErrorHandlerRegistry.get(ctx.metadata)
  if (!list) {
    list = []
    ControllerErrorHandlerRegistry.set(ctx.metadata, list)
  }

  for (const error of errors) {
    list.push([error, ctx.name])
  }
}

/** The decorator that adds a hook at `point`: `onRequest` is `OnRequest`. */
export function hookDecoratorName(point: RequestHookName): string {
  return point[0].toUpperCase() + point.slice(1)
}

// Registers a controller method as a hook at `point` for every route of the controller. A method that is also a route
// is refused at build, as `@Catch` methods are: throwing here would break module import.
export function configureControllerHook(ctx: ClassMethodDecoratorContext, point: RequestHookName) {
  let list = ControllerHookRegistry.get(ctx.metadata)
  if (!list) {
    list = []
    ControllerHookRegistry.set(ctx.metadata, list)
  }

  list.push([point, ctx.name])
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

/**
 * Registers (or amends) the router of `key` without a decorator context.
 *
 * The registry is a module-level WeakMap that only decorators reach, which leaves a package building routes
 * programmatically — `@caffeinejs/openapi` mounting its own document endpoints — with nowhere to put them. Going
 * through here means those routes are indistinguishable from decorated ones by the time `buildRouting` reads them,
 * so they inherit authentication, authorization, and error handling instead of reimplementing each.
 *
 * Must run before `buildRouting`, i.e. no later than a service's `configure()`.
 */
export function registerRouteGroup(key: Function, mut: (spec: RouteGroupBuilder) => void): void {
  let cur = RouteGroupRegistry.get(key)
  if (!cur) {
    cur = new RouteGroupBuilder()
    RouteGroupRegistry.set(key, cur)
  }

  mut(cur)
}

export function configureRouteGroup(
  _ctx: ClassDecoratorContext,
  key: Function,
  mut: (spec: RouteGroupBuilder) => void,
): void {
  registerRouteGroup(key, mut)
}

export function configureRouteGroupAndRegisterRoutes(
  ctx: ClassDecoratorContext,
  key: Function,
  mut: (spec: RouteGroupBuilder) => void,
): void {
  registerRouteGroup(key, cur => {
    cur.routes(Array.from(RouteRegistry.get(ctx.metadata)?.values() ?? []) as RouteBuilder[])

    const errorHandlers = ControllerErrorHandlerRegistry.get(ctx.metadata)
    if (errorHandlers?.length) {
      cur.errorHandlers(errorHandlers)
    }

    const hooks = ControllerHookRegistry.get(ctx.metadata)
    if (hooks?.length) {
      cur.methodHooks(hooks)
    }

    mut(cur)
  })
}

export function getRouteGroup(key: Function): RouteGroupBuilder | undefined {
  return RouteGroupRegistry.get(key)
}
