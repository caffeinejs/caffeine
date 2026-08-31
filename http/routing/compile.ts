import { Container, Ctor, InjectionToken } from '@caffeinejs/di'
import { CatchMetadata, ErrConfiguration, ErrorHandler, ErrorHandlerRef, kErrorHandler } from '../error/index.js'
import { solutions } from '../error/util.js'
import { CatchByMap, Route, Router, RouterErrorHandler } from '../route.js'
import { AuthorizationOptions, AuthzRequirement, AuthzRequirementHandler, compileRoutePolicy, kAuthzEvaluators, kAuthzHandlers, kAuthzOpts, PolicyEvaluator } from '../security/authz/index.js'
import { compileGuardKeys, type CompiledGuard } from '../guards/compile.js'
import { kGlobalGuards, type GuardRef } from '../guards/keys.js'
import { Guard } from '../guards/index.js'
import type { RouteAuthzOptions, RouteSpec, RouterSpec } from './spec.js'
import type { RouteDispatch, RouteGroupHook } from './dispatch.js'

/** What a route source contributes on top of the spec: identity, and how the routes are invoked. */
export interface RouterMeta<R> {
  /** The group's display name, used in diagnostics and by the documentation generator. */
  name: string
  /** The class that declared the group, when one did. */
  target?: Function
  onRequest?: RouteGroupHook<R, unknown>
  handleError?: RouterErrorHandler<R>
  /**
   * The dispatch for one route. A source that leaves it undefined gets the spec's own `handle` called with the
   * picked arguments, which is all a plain function needs.
   */
  dispatch?(route: RouteSpec<R>): RouteDispatch<R, unknown>
}

/** Compiles a spec into a registrable {@link Router}. See {@link createRouterCompiler}. */
export type RouterCompiler = <R>(spec: RouterSpec<R>, meta: RouterMeta<R>) => Router<R>

/**
 * Builds the compiler every route source shares.
 *
 * The guard cache and the authorization configuration are resolved once here rather than per group, so two
 * sources compiling routes into the same application see one guard instance per key and one set of policies.
 */
export function createRouterCompiler(container: Container): RouterCompiler {
  // Authorization is always configured, so its evaluators/handlers/options are always bound.
  const authzEvaluators: Map<string, PolicyEvaluator> = container.get(kAuthzEvaluators)
  const authzHandlers: Map<string, AuthzRequirementHandler<AuthzRequirement>> = container.get(kAuthzHandlers)
  const authzOptions: AuthorizationOptions = container.get(kAuthzOpts)

  const compiledGuards = new Map<GuardRef, CompiledGuard>()
  const globalGuardKeys = container.get<readonly GuardRef[]>(kGlobalGuards)
  const globalGuards = compileGuardKeys(container, globalGuardKeys, 'application', compiledGuards)

  return function compileRouter<R>(spec: RouterSpec<R>, meta: RouterMeta<R>): Router<R> {
    const compileRoute = (route: RouteSpec<R>): Route<R> => {
      const config = new Map<string, unknown>()
      if (spec.config) {
        for (const [k, v] of spec.config) {
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
      if (spec.options) {
        for (const [k, v] of spec.options) {
          options.set(k, v)
        }
      }
      if (route.options) {
        for (const [k, v] of route.options) {
          options.set(k, v)
        }
      }

      const header = new Map<string, string | string[]>()
      if (spec.header) {
        for (const [k, v] of spec.header) {
          header.set(k, v)
        }
      }
      if (route.header) {
        for (const [k, v] of route.header) {
          header.set(k, v)
        }
      }
      const hasHeader = !!spec.header || !!route.header

      const owner = `${meta.name}.${String(route.name)}`

      return {
        path: route.path,
        method: route.method,
        // `??` cannot express this: `toRoute()` defaults these to `[]` and `''`, never nullish, so a
        // group-level @Consumes/@Produces would never reach a route that declares none of its own.
        accept: route.accept.length > 0 ? route.accept : spec.accept,
        contentType: route.contentType !== '' ? route.contentType : spec.contentType,
        parameters: route.parameters,
        name: route.name,
        dispatch: meta.dispatch?.(route) ?? defaultDispatch(route),
        schema: route.schema,
        bodyLimit: route.bodyLimit ?? spec.bodyLimit,
        timeout: route.timeout ?? spec.timeout,
        header,
        hasHeader,
        statusCode: route.statusCode,
        config: config,
        options: options,
        extras: route.extras,
        catchBy: buildCatchByMap(container, route.catchBy, owner),
        guards: compileRouteGuardChain(
          container,
          compiledGuards,
          globalGuards,
          spec.guards,
          route.guards,
          owner,
        ),
        guardOptions: compileGuardOptions(spec, route),
        authorization: (() => {
          // Always compiled, never gated on a decorator being present: an undecorated route is exactly
          // the one a configured fallback policy has to reach, and compileRoutePolicy is what knows
          // whether there is one. It returns undefined when the route really is ungated.
          const authorizer = compileRoutePolicy(
            authzOptions,
            authzEvaluators,
            authzHandlers,
            spec.authz,
            route.authz,
          )

          return {
            // Drives the "authorization configured but authentication is not" start-up check, so it has
            // to follow what actually gates the route rather than what was written on it.
            hasProtection: authorizer !== undefined,
            options: mergeAuthz(spec.authz, route.authz),
            authorizer,
          }
        })(),
      }
    }

    return {
      path: spec.path,
      prefix: spec.prefix,
      name: meta.name,
      target: meta.target,
      onRequest: meta.onRequest,
      handleError: meta.handleError,
      catchBy: buildCatchByMap(container, spec.catchBy, meta.name),
      // Kept on the router rather than merged down: group-level metadata describes the group, and
      // `mergeValue`'s array-concat/Map-union semantics would mangle arbitrary symbol payloads on the way.
      extras: spec.extras,
      routes: spec.routes.map(compileRoute),
    }
  }
}

/**
 * The dispatch of a route whose source declared a plain function: call it with the picked arguments.
 *
 * A spec with neither `handle` nor a source-supplied dispatch is a source bug, and it is worth catching while
 * routes are being registered rather than on the first request.
 */
function defaultDispatch<R>(route: RouteSpec<R>): RouteDispatch<R, unknown> {
  const handle = route.handle

  if (handle === undefined) {
    throw new ErrConfiguration(
      `Cannot compile route "${String(route.name)}": it declares no handler`
      + solutions(
        'Set the function to call with "RouteBuilder.handle(fn)"',
        'Supply a dispatch for the route from the route source that declared it',
      ),
    )
  }

  return compilers => compilers.handler(route.parameters, handle)
}

/**
 * The authorization options actually in force on a route, combining what the group declared with what the
 * route declared.
 *
 * Previously only the route's own options were surfaced, so `@Authorize({ schemes })` or `@Roles` on a
 * *controller* was invisible to everything reading `Route.authorization.options` — per-route scheme selection
 * and the OpenAPI generator's security block among them — even though `compileRoutePolicy` was enforcing it
 * all along from the raw group/route pair.
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

// Resolves the "@CatchWith" references of a group or route into a map of error type to handler
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
    const name = typeof ref === 'function' ? ref.name : String(ref)
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
