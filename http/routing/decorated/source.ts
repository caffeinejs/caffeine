import { Ctor, InjectionToken, Provider, Scopes } from '@caffeinejs/di'
import { ErrCaffeineWebApplication, ErrConfiguration, resolveByErrorChain } from '../../error/index.js'
import { solutions } from '../../error/util.js'
import { kErrorUnhandled, type RouteGroup, type RouteGroupErrorHandler } from '../../route.js'
import type { RouteDispatch } from '../dispatch.js'
import type { RouteGroupMeta } from '../compile.js'
import type { RouteBuildContext, RouteSource } from '../source.js'
import type { RouteSpec, RouteGroupSpec } from '../spec.js'
import { Keys } from '../../symbols.js'
import { getRouteGroup } from '../../decorators/registrar/registrar.js'

/** The instance a route is dispatched on, as the adapter stashes it for the request. */
interface RequestWithTarget {
  routeTarget: ControllerInstance | null
}

type ControllerInstance = Record<string | symbol, (...args: unknown[]) => unknown>

/**
 * The routes declared with `@Controller` and the verb decorators.
 *
 * This is the only place that knows a route may live on a class: it reads the decorator registry, resolves the
 * controller from the container, and turns each method key into a dispatch. Everything downstream — the
 * compiler, the adapter, the error handler — sees routes with no class in them.
 */
export class ControllerRouteSource<R = unknown> implements RouteSource<R> {
  readonly name = 'controller'

  build(ctx: RouteBuildContext): RouteGroup<R>[] {
    const container = ctx.container
    const controllers = container.getBindingsByLabel(Keys.CONTROLLER)
    const routeGroups = new Array<RouteGroup<R>>(controllers.length)

    for (let i = 0; i < controllers.length; i++) {
      const { key, binding } = controllers[i]
      const rd = getRouteGroup(key as Function)
      if (!rd) {
        throw new ErrCaffeineWebApplication(
          `Cannot build router: no route definition found for router "${String(key)}"`,
          'ERR_HTTP_MISSING_ROUTER',
        )
      }

      const spec = rd.toRouteGroup<R>()
      const provider = container.wrap(key as InjectionToken<ControllerInstance>)

      routeGroups[i] = ctx.compileRouteGroup(spec, meta<R>(spec, key, binding.scopeID === Scopes.SINGLETON, provider))
    }

    return routeGroups
  }
}

function meta<R>(
  spec: RouteGroupSpec<R>,
  key: InjectionToken,
  isSingleton: boolean,
  provider: Provider<ControllerInstance>,
): RouteGroupMeta<R> {
  const name = typeof key === 'function' ? key.name : String(key)
  const errorHandlers = buildErrorHandlerMap(
    spec.errorHandlers,
    key,
    new Set(spec.routes.map(route => route.name)),
  )

  // The `@Catch` method form needs the controller instance that threw, so when it is in play the instance is
  // resolved once per request (inside the live request scope) and reused by the route dispatch — correct for
  // transient scope, where a second `get()` would be a second instance.
  if (errorHandlers === undefined) {
    return {
      name,
      target: typeof key === 'function' ? key : undefined,
      dispatch: route => directDispatch(route, isSingleton, provider),
    }
  }

  const ref = isSingleton ? provider.get() : null

  return {
    name,
    target: typeof key === 'function' ? key : undefined,
    onRequest: (req, _res, done) => {
      (req as RequestWithTarget).routeTarget = ref ?? provider.get()
      done()
    },
    handleError: sharedTargetErrorHandler<R>(errorHandlers),
    dispatch: route => sharedTargetDispatch<R>(route),
  }
}

/** Dispatch straight onto the controller, for a group with no `@Catch` methods to share an instance with. */
function directDispatch<R>(
  route: RouteSpec<R>,
  isSingleton: boolean,
  provider: Provider<ControllerInstance>,
): RouteDispatch<R, unknown> {
  const handlerKey = route.name

  if (isSingleton) {
    // Resolved and bound while the route is being registered: a singleton controller cannot change, so
    // nothing about the lookup belongs in the request path.
    const ref = provider.get()
    const fn = (ref[handlerKey] as (...args: unknown[]) => unknown).bind(ref)

    return compilers => compilers.handler(route.parameters, fn)
  }

  return compilers => compilers.handler(route.parameters, (...args) => {
    const ctrl = provider.get()
    return (ctrl[handlerKey] as (...args: unknown[]) => unknown).apply(ctrl, args)
  })
}

/** Dispatch onto the instance the group's `onRequest` resolved, so the error handler sees the same one. */
function sharedTargetDispatch<R>(route: RouteSpec<R>): RouteDispatch<R, unknown> {
  const handlerKey = route.name

  return compilers => {
    const pickArgs = compilers.args(route.parameters)

    return async (req, res) => {
      const instance = (req as RequestWithTarget).routeTarget!
      const args = await pickArgs(req, res)

      return (instance[handlerKey] as (...args: unknown[]) => unknown).apply(instance, args)
    }
  }
}

function sharedTargetErrorHandler<R>(
  errorHandlers: Map<Ctor<Error>, string | symbol>,
): RouteGroupErrorHandler<R> {
  return (req, ctx, err) => {
    // Null when the error came from a hook that ran before the group's own — a rejected authentication, say.
    // There is no instance to dispatch on, so the error belongs to the application-wide handler.
    const instance = (req as RequestWithTarget).routeTarget
    if (instance === null) {
      return kErrorUnhandled
    }

    const methodKey = resolveByErrorChain(errorHandlers, err)
    if (methodKey === undefined) {
      return kErrorUnhandled
    }

    return instance[methodKey].apply(instance, [ctx, err])
  }
}

// Converts the raw per-controller error-handler list into a lookup map, rejecting two handlers for
// the same error type. Runs at build (app.ready()), so the throw is observable, not an import crash.
function buildErrorHandlerMap(
  handlers: Array<[Ctor<Error>, string | symbol]> | undefined,
  controllerKey: unknown,
  routeHandlers: Set<string | symbol>,
): Map<Ctor<Error>, string | symbol> | undefined {
  if (!handlers?.length) {
    return undefined
  }

  const map = new Map<Ctor<Error>, string | symbol>()
  for (const [errorType, methodKey] of handlers) {
    if (routeHandlers.has(methodKey)) {
      throw new ErrConfiguration(
        `Method "${String(methodKey)}" in "${String(controllerKey)}" cannot be both a route and an error handler`
        + solutions(`Move the "@Catch(${errorType.name})" handler to a method without a route verb decorator`),
      )
    }

    if (map.has(errorType)) {
      throw new ErrConfiguration(
        `Ambiguous controller error handler: multiple handlers registered for "${errorType.name}" in "${String(controllerKey)}"`
        + solutions(`Keep a single "@Catch(${errorType.name})" method per controller`),
      )
    }

    map.set(errorType, methodKey)
  }

  return map
}
