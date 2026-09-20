import { Container, Ctor, InjectionToken } from '@caffeinejs/di'

import { CatchMetadata, ErrConfiguration, ErrorHandler, ErrorHandlerRef, kErrorHandler } from '../error/index.js'
import { solutions } from '../error/util.js'
import { compileGuardKeys, type CompiledGuard } from '../guards/compile.js'
import type { Guard } from '../guards/index.js'
import { kGlobalGuards } from '../guards/keys.js'
import { CatchByMap, Route, RouteGroup, RouteGroupErrorHandler } from '../route.js'
import { AuthenticationSchemeProvider } from '../security/auth/scheme_provider.js'
import {
  AuthorizationOptions,
  AuthzRequirement,
  AuthzRequirementHandler,
  compileRoutePolicy,
  kAuthzEvaluators,
  kAuthzHandlers,
  kAuthzOpts,
  PolicyEvaluator,
} from '../security/authz/index.js'
import type { RouteDispatch, RouteGroupHook } from './dispatch.js'
import { mergeAuthz } from './inherit.js'
import type { RouteAuthz, RouteSpec, RouteGroupSpec } from './spec.js'

/** What a route source contributes on top of the spec: identity, and how the routes are invoked. */
export interface RouteGroupMeta<R> {
  /** The group's display name, used in diagnostics and by the documentation generator. */
  name: string
  /** The class that declared the group, when one did. */
  target?: Function
  onRequest?: RouteGroupHook<R, unknown>
  handleError?: RouteGroupErrorHandler<R>
  /**
   * The dispatch for one route. A source that leaves it undefined gets the spec's own `handle` called with the
   * picked arguments, which is all a plain function needs.
   */
  dispatch?(route: RouteSpec<R>): RouteDispatch<R, unknown>
}

/** Compiles a spec into a registrable {@link RouteGroup}. See {@link createRouteGroupCompiler}. */
export type RouteGroupCompiler = <R>(spec: RouteGroupSpec<R>, meta: RouteGroupMeta<R>) => RouteGroup<R>

/**
 * Builds the compiler every route source shares.
 *
 * The guard cache and the authorization configuration are resolved once here rather than per group, so two
 * sources compiling routes into the same application see one guard instance per key and one set of policies.
 */
export function createRouteGroupCompiler(container: Container): RouteGroupCompiler {
  // Absent when the application never installed authorization — no `.authentication(...)` and no explicit
  // `.authorization(...)`. A protected route with authorization absent is refused separately, at start-up, by
  // `assertAuthorizationConfigured` — not here, so the failure names the real cause instead of a missing
  // handler/policy.
  const authzOpts = container.getOptional<AuthorizationOptions>(kAuthzOpts)
  const authzInstalled = authzOpts !== undefined
  const authzEvaluators = authzInstalled ? container.get<Map<string, PolicyEvaluator>>(kAuthzEvaluators) : undefined
  const authzHandlers = authzInstalled
    ? container.get<Map<string, AuthzRequirementHandler<AuthzRequirement>>>(kAuthzHandlers)
    : undefined

  const compiledGuards = new Map<InjectionToken<Guard>, CompiledGuard>()
  // Absent when the application never called `.guards(...)` — no global guards, same as an empty list.
  const globalGuardKeys = container.getOptional(kGlobalGuards) ?? []
  const globalGuards = dedupe(compileGuardKeys(container, globalGuardKeys, 'application', compiledGuards))

  // Absent when the application configured no authentication, which leaves every route naming no scheme of
  // its own with none.
  const defaultScheme = container.getOptional(AuthenticationSchemeProvider)?.defaultAuthenticateScheme

  return function compileRouteGroup<R>(spec: RouteGroupSpec<R>, meta: RouteGroupMeta<R>): RouteGroup<R> {
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
        bodyAs: route.bodyAs,
        config: config,
        options: options,
        // Copied, not shared: a plugin enriching the compiled route's detail from an `onRoute` hook must not
        // write back into the spec the route was authored from.
        detail: route.detail === undefined ? undefined : { ...route.detail },
        catchBy: buildCatchByMap(container, route.catchBy, owner),
        guards: compileRouteGuardChain(container, compiledGuards, globalGuards, spec.guards, route.guards, owner),
        authorization: (() => {
          // Always compiled, never gated on a decorator being present: an undecorated route is exactly
          // the one a configured fallback policy has to reach, and compileRoutePolicy is what knows
          // whether there is one. It returns undefined when the route really is ungated.
          //
          // Skipped entirely when authorization is not installed: compileRoutePolicy would throw a
          // handler/policy-not-found error for a route that actually declares protection, and the real
          // cause — authorization was never configured — belongs to assertAuthorizationConfigured instead.
          const authz = mergeAuthz(spec.authz, route.authz)
          const authorizer = authzInstalled
            ? compileRoutePolicy(authzOpts!, authzEvaluators!, authzHandlers!, authz)
            : undefined

          return {
            // Drives the "authorization configured but authentication is not" start-up check, so it has
            // to follow what actually gates the route rather than what was written on it.
            hasProtection: authzInstalled ? authorizer !== undefined : declaresAuthzProtection(authz),
            options: authz,
            authorizer,
            // Folded in here, where the application's default is known, so nothing downstream has to reach
            // into the authentication feature to find out which scheme an unnamed route ends up on.
            schemes: effectiveSchemes(authz?.schemes, defaultScheme),
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
      // Kept on the router rather than merged down: group-level metadata describes the group, and a reader
      // that wants both levels reads them separately rather than receiving one flattened bag.
      detail: spec.detail,
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
      `Cannot compile route "${String(route.name)}": it declares no handler` +
        solutions(
          'Set the function to call with "RouteBuilder.handle(fn)"',
          'Supply a dispatch for the route from the route source that declared it',
        ),
    )
  }

  return compilers => compilers.handler(route.parameters, handle)
}

/**
 * Whether a route declares authorization protection, without needing a policy to evaluate it — used only
 * when authorization is not installed, where {@link compileRoutePolicy} cannot run.
 */
function declaresAuthzProtection(authz: RouteAuthz | undefined): boolean {
  return authz !== undefined && !authz.allowAnonymous
}

function compileRouteGuardChain(
  container: Container,
  compiledGuards: Map<InjectionToken<Guard>, CompiledGuard>,
  globalGuards: readonly CompiledGuard[],
  routerGuards: InjectionToken<Guard>[] | undefined,
  routeGuards: InjectionToken<Guard>[] | undefined,
  owner: string,
): readonly CompiledGuard[] | undefined {
  const routerKeys = routerGuards ?? []
  const routeKeys = routeGuards ?? []
  const local = compileGuardKeys(container, [...routerKeys, ...routeKeys], owner, compiledGuards)

  if (globalGuards.length === 0 && local.length === 0) {
    return undefined
  }

  if (local.length === 0) {
    return globalGuards
  }

  return dedupe([...globalGuards, ...local])
}

// One compiled entry per token, so a guard listed twice for a route runs once, where it first appears.
function dedupe(chain: CompiledGuard[]): CompiledGuard[] {
  return [...new Set(chain)]
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
        `Cannot resolve error handler "${name}" referenced by "${owner}": no binding registered` +
          solutions(
            `Decorate "${name}" with "@Catch(ErrorType)" so it is registered in the container`,
            'Make sure the handler module is imported by the application',
          ),
      )
    }

    const meta = binding.tags.get(kErrorHandler) as CatchMetadata | undefined
    if (!meta) {
      throw new ErrConfiguration(
        `Cannot use "${name}" as an error handler in "${owner}": it is not decorated with "@Catch"` +
          solutions(`Decorate "${name}" with "@Catch(ErrorType)" to declare the errors it handles`),
      )
    }

    const provider = container.wrapBinding<ErrorHandler<Error>>(binding)
    for (const errorType of meta.errors) {
      const previous = owners.get(errorType)
      if (previous !== undefined) {
        throw new ErrConfiguration(
          `Ambiguous "@CatchWith" in "${owner}": both "${previous}" and "${name}" handle "${errorType.name}"` +
            solutions(`Keep a single handler for "${errorType.name}" at this level`),
        )
      }

      owners.set(errorType, name)
      map.set(errorType, provider)
    }
  }

  return map
}

/**
 * The scheme names that authenticate a route: the ones it named, or the application's default when it named
 * none.
 *
 * Resolved once per route, while it is compiled, so nothing downstream has to know that "named no scheme"
 * means "whatever the authentication feature defaults to".
 */
function effectiveSchemes(named: readonly string[] | undefined, defaultScheme: string | undefined): readonly string[] {
  if (named !== undefined && named.length > 0) {
    return named
  }

  return defaultScheme === undefined ? [] : [defaultScheme]
}
