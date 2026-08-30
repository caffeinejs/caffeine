import { Container, Ctor, InjectionToken } from '@caffeinejs/di'
import { CatchMetadata, ErrCaffeineWebApplication, ErrConfiguration, ErrorHandler, ErrorHandlerRef, kErrorHandler } from '../error/index.js'
import { solutions } from '../error/util.js'
import { Keys } from '../symbols.js'
import { CatchByMap, Router } from '../route.js'
import { AuthorizationOptions, AuthzRequirement, AuthzRequirementHandler, compileRoutePolicy, kAuthzEvaluators, kAuthzHandlers, kAuthzOpts, PolicyEvaluator } from '../security/authz/index.js'
import { getRouter, RouterSpec, RouteSpec, type RouteAuthzOptions } from '../decorators/registrar/index.js'
import { compileGuardKeys, type CompiledGuard } from '../guards/compile.js'
import { kGlobalGuards, type GuardRef } from '../guards/keys.js'
import { Guard } from '../guards/index.js'

export function buildRouting<REQ>(container: Container): Router<REQ>[] {
  // Authorization is always configured, so its evaluators/handlers/options are always bound.
  const authzEvaluators: Map<string, PolicyEvaluator> = container.get(kAuthzEvaluators)
  const authzHandlers: Map<string, AuthzRequirementHandler<AuthzRequirement>> = container.get(kAuthzHandlers)
  const authzOptions: AuthorizationOptions = container.get(kAuthzOpts)

  const compiledGuards = new Map<GuardRef, CompiledGuard>()
  const globalGuardKeys = container.get<readonly GuardRef[]>(kGlobalGuards)
  const globalGuards = compileGuardKeys(container, globalGuardKeys, 'application', compiledGuards)

  const controllers = container.getBindingsByLabel(Keys.CONTROLLER)
  const routers = new Array<Router<REQ>>(controllers.length)

  for (let i = 0; i < controllers.length; i++) {
    const { key, binding } = controllers[i]
    const rd = getRouter(key as Function)
    if (!rd) {
      throw new ErrCaffeineWebApplication(
        `Cannot build router: no route definition found for router "${String(key)}"`,
        'ERR_HTTP_MISSING_ROUTER',
      )
    }

    const router = rd.toRouter<REQ>()

    routers[i] = {
      path: router.path,
      prefix: router.prefix,
      key,
      binding,
      controller: container.wrap(key as InjectionToken<Record<string | symbol, (...args: unknown[]) => unknown>>),
      errorHandlers: buildErrorHandlerMap(router.errorHandlers, key, new Set(router.routes.map(r => r.handler))),
      catchBy: buildCatchByMap(container, router.catchBy, refName(key)),
      // Kept on the router rather than merged down: class-level metadata describes the controller, and
      // `mergeValue`'s array-concat/Map-union semantics would mangle arbitrary symbol payloads on the way.
      extras: router.extras,
      routes: router.routes.map(route => {
        const config = new Map<string, unknown>()
        if (router.config) {
          for (const [k, v] of router.config) {
            config.set(k, v)
          }
        }
        if (route.config) {
          for (const [k, v] of route.config) {
            config.set(k, v)
          }
        }

        // Route Options
        // https://fastify.dev/docs/latest/Reference/Routes/#routes-options
        const options = new Map<string, unknown>()
        if (router.options) {
          for (const [k, v] of router.options) {
            options.set(k, v)
          }
        }
        if (route.options) {
          for (const [k, v] of route.options) {
            options.set(k, v)
          }
        }

        const header = new Map<string, string | string[]>()
        if (router.header) {
          for (const [k, v] of router.header) {
            header.set(k, v)
          }
        }
        if (route.header) {
          for (const [k, v] of route.header) {
            header.set(k, v)
          }
        }
        const hasHeader = !!router.header || !!route.header

        return {
          path: route.path,
          method: route.method,
          // `??` cannot express this: `toRoute()` defaults these to `[]` and `''`, never nullish, so a
          // controller-level @Consumes/@Produces would never reach a route that declares none of its own.
          accept: route.accept.length > 0 ? route.accept : router.accept,
          contentType: route.contentType !== '' ? route.contentType : router.contentType,
          parameters: route.parameters,
          handler: route.handler,
          schema: route.schema,
          bodyLimit: route.bodyLimit ?? router.bodyLimit,
          timeout: route.timeout ?? router.timeout,
          header,
          hasHeader,
          statusCode: route.statusCode,
          config: config,
          options: options,
          extras: route.extras,
          catchBy: buildCatchByMap(container, route.catchBy, `${refName(key)}.${String(route.handler)}`),
          guards: compileRouteGuardChain(
            container,
            compiledGuards,
            globalGuards,
            router.guards,
            route.guards,
            `${refName(key)}.${String(route.handler)}`,
          ),
          guardOptions: compileGuardOptions(router, route),
          authorization: (() => {
            // Always compiled, never gated on a decorator being present: an undecorated route is exactly
            // the one a configured fallback policy has to reach, and compileRoutePolicy is what knows
            // whether there is one. It returns undefined when the route really is ungated.
            const authorizer = compileRoutePolicy(
              authzOptions,
              authzEvaluators,
              authzHandlers,
              router.authz,
              route.authz,
            )

            return {
              // Drives the "authorization configured but authentication is not" start-up check, so it has
              // to follow what actually gates the route rather than what was written on it.
              hasProtection: authorizer !== undefined,
              options: mergeAuthz(router.authz, route.authz),
              authorizer,
            }
          })(),
        }
      }),
    }
  }

  return routers
}

/**
 * The authorization options actually in force on a route, combining what the controller declared with what
 * the method declared.
 *
 * Previously only the route's own options were surfaced, so `@Authorize({ schemes })` or `@Roles` on a
 * *controller* was invisible to everything reading `Route.authorization.options` — per-route scheme selection
 * and the OpenAPI generator's security block among them — even though `compileRoutePolicy` was enforcing it
 * all along from the raw router/route pair.
 *
 * Merge follows what `compileRoutePolicy` does with the same inputs: single-valued fields take the route's
 * value when it has one, and `roles`/`policy` are unioned, because the compiled policy requires *both* sets.
 */
function mergeAuthz(
  router: RouteAuthzOptions | undefined,
  route: RouteAuthzOptions | undefined,
): RouteAuthzOptions | undefined {
  if (router === undefined) {
    return route
  }
  if (route === undefined) {
    return router
  }

  const roles = [...new Set([...(router.roles ?? []), ...(route.roles ?? [])])]
  const policy = [...new Set([...normalizeList(router.policy), ...normalizeList(route.policy)])]

  return {
    allowAnonymous: route.allowAnonymous ?? router.allowAnonymous,
    schemes: route.schemes ?? router.schemes,
    ...(roles.length > 0 ? { roles } : {}),
    ...(policy.length > 0 ? { policy } : {}),
  }
}

function normalizeList(value: string | string[] | undefined): string[] {
  if (value == null) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

function compileRouteGuardChain(
  container: Container,
  compiledGuards: Map<GuardRef, CompiledGuard>,
  globalGuards: CompiledGuard[],
  routerGuards: InjectionToken<Guard>[] | undefined,
  routeGuards: InjectionToken<Guard>[] | undefined,
  owner: string,
): CompiledGuard[] | undefined {
  const routerKeys = routerGuards ?? []
  const routeKeys = routeGuards ?? []
  const local = compileGuardKeys(container, [...routerKeys, ...routeKeys], owner, compiledGuards)

  if (globalGuards.length === 0 && local.length === 0) {
    return undefined
  }

  if (local.length === 0) {
    return globalGuards
  }

  if (globalGuards.length === 0) {
    return local
  }

  return [...globalGuards, ...local]
}

function refName(ref: unknown): string {
  return typeof ref === 'function' ? ref.name : String(ref)
}

// Resolves the "@CatchWith" references of a controller or route into a map of error type to handler
// provider. Resolution goes through the container, so a reference by class or by "@Named" identifier
// honours @Primary, @ConditionalOn and @Profile like any other injection point.
function buildCatchByMap(
  container: Container,
  refs: ErrorHandlerRef[] | undefined,
  owner: string,
): CatchByMap | undefined {
  if (!refs?.length) {
    return undefined
  }

  const map: CatchByMap = new Map()
  const owners = new Map<Ctor<Error>, string>()

  for (const ref of refs) {
    const name = refName(ref)
    const binding = container.getBinding(ref)
    if (!binding) {
      throw new ErrConfiguration(
        `Cannot resolve error handler "${name}" referenced by "${owner}": no binding registered`
        + solutions(
          `Decorate "${name}" with "@Catch(ErrorType)" so it is registered in the container`,
          'Make sure the handler module is imported by the application',
        ),
      )
    }

    const meta = binding.tags.get(kErrorHandler) as CatchMetadata | undefined
    if (!meta) {
      throw new ErrConfiguration(
        `Cannot use "${name}" as an error handler in "${owner}": it is not decorated with "@Catch"`
        + solutions(`Decorate "${name}" with "@Catch(ErrorType)" to declare the errors it handles`),
      )
    }

    const provider = container.wrapBinding<ErrorHandler<Error>>(binding)
    for (const errorType of meta.errors) {
      const previous = owners.get(errorType)
      if (previous !== undefined) {
        throw new ErrConfiguration(
          `Ambiguous "@CatchWith" in "${owner}": both "${previous}" and "${name}" handle "${errorType.name}"`
          + solutions(`Keep a single handler for "${errorType.name}" at this level`),
        )
      }

      owners.set(errorType, name)
      map.set(errorType, provider)
    }
  }

  return map
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

function compileGuardOptions<R>(
  router: RouterSpec<R>,
  route: RouteSpec<R>,
): Record<string | symbol, unknown> {
  const guardOptions: Record<string | symbol, unknown> = {}

  if (router.guardOptions) {
    for (const [k, v] of Object.entries(router.guardOptions)) {
      guardOptions[k] = v
    }
  }

  if (route.guardOptions) {
    for (const [k, v] of Object.entries(route.guardOptions)) {
      guardOptions[k] = v
    }
  }

  return guardOptions
}
