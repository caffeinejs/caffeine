import { compileGuardKeys, type CompiledGuard } from '@caffeinejs/application/framework'
import { Container, InjectionToken } from '@caffeinejs/di'
import { errMessage } from '@caffeinejs/std/err'

import { boundTo } from '../../binding.js'
import type { HTTPSetupContext } from '../../plugin.js'
import { buildCatchByMap, ErrConfiguration } from '../error/index.js'
import type { Guard } from '../guards/index.js'
import { kGlobalGuards } from '../guards/keys.js'
import { REQUEST_HOOK_NAMES } from '../lifecycle/lifecycle.js'
import type { AuthoredHooks } from '../lifecycle/route_definition.js'
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
import { isAccessControlExempt } from '../security/exempt.js'
import { mergeAuthz } from './inherit.js'
import {
  applyRouteOptions,
  kNoRouteOptions,
  layerRouteOptions,
  resolveRouteOptionLevels,
  type RouteOptions,
  type RouteOptionsLevel,
} from './options.js'
import {
  IRoute,
  IRouteGroup,
  RouteGroupErrorHandler,
  type CompiledHooks,
  type RouteDispatch,
  type RouteGroupHook,
} from './route.js'
import type { RouteAuthz, RouteSpec, RouteGroupSpec } from './spec.js'

/** What a route source contributes on top of the spec: identity, and how the routes are invoked. */
export interface RouteGroupMeta<R> {
  /** The group's display name, used in diagnostics and by the documentation generator. */
  name: string
  /** The class that declared the group, when one did. */
  target?: Function
  onRequest?: RouteGroupHook<R, unknown>
  handleError?: RouteGroupErrorHandler<R>
  /** Hooks the source adds to every route of the group, after the group's own: a controller's hook methods. */
  hooks?: CompiledHooks<R>
  /**
   * The dispatch for one route. A source that leaves it undefined gets the spec's own `handle` called with the
   * picked arguments, which is all a plain function needs.
   */
  dispatch?(route: RouteSpec<R>): RouteDispatch<R, unknown>
}

/** Compiles a spec into a registrable {@link IRouteGroup}. See {@link createRouteGroupCompiler}. */
export type RouteGroupCompiler = <R>(spec: RouteGroupSpec<R>, meta: RouteGroupMeta<R>) => IRouteGroup<R>

/**
 * Builds the compiler every route source shares.
 *
 * The guard cache and the authorization configuration are resolved once here rather than per group, so two
 * sources compiling routes into the same application see one guard instance per key and one set of policies.
 */
export function createRouteGroupCompiler(context: Omit<HTTPSetupContext, 'server'>): RouteGroupCompiler {
  const container = context.container
  // Absent when the application never installed authorization — no authentication feature and no explicit
  // `Authorization(...)`. A protected route with authorization absent is refused separately, at start-up, by
  // `assertAuthorizationConfigured` — not here, so the failure names the real cause instead of a missing
  // handler/policy.
  const authzOpts = container.getOptional<AuthorizationOptions>(kAuthzOpts)
  const authzInstalled = authzOpts !== undefined
  const authzEvaluators = authzInstalled ? container.get<Map<string, PolicyEvaluator>>(kAuthzEvaluators) : undefined
  const authzHandlers = authzInstalled
    ? container.get<Map<string, AuthzRequirementHandler<AuthzRequirement>>>(kAuthzHandlers)
    : undefined

  const compiledGuards = new Map<InjectionToken<Guard>, CompiledGuard<Guard>>()
  // Absent when the application never installed `Guards(...)` — no global guards, same as an empty list.
  const globalGuardKeys = container.getOptional(kGlobalGuards) ?? []
  const globalGuards = dedupe(compileGuardKeys(container, globalGuardKeys, 'application', compiledGuards))

  // Absent when the application configured no authentication, which leaves every route naming no scheme of
  // its own with none.
  const defaultScheme = container.getOptional(AuthenticationSchemeProvider)?.defaultAuthenticateScheme

  // A router's level is one array in every group nested under it: resolved once, its configurers run once.
  const resolvedLevels = new WeakMap<RouteOptionsLevel, Partial<RouteOptions>>()

  return function compileRouteGroup<R>(spec: RouteGroupSpec<R>, meta: RouteGroupMeta<R>): IRouteGroup<R> {
    // Once for the group, shared by every route that sets none of its own; a route's own keys replace the group's.
    const groupOptions =
      spec.options === undefined
        ? kNoRouteOptions
        : Object.freeze(resolveRouteOptionLevels(spec.options, context, meta.name, resolvedLevels))

    const compileRoute = (route: RouteSpec<R>): IRoute<R> => {
      const owner = `${meta.name}.${String(route.name)}`
      const options =
        route.options === undefined
          ? groupOptions
          : Object.freeze(layerRouteOptions(groupOptions, applyRouteOptions(route.options, context, owner)))

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

      // A route the framework serves on the application's behalf: no global guard and no authorization reach it.
      const exempt = isAccessControlExempt(options)

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
        options,
        // Copied, not shared: a plugin enriching the compiled route's detail from an `onRoute` hook must not
        // write back into the spec the route was authored from.
        detail: route.detail === undefined ? undefined : { ...route.detail },
        catchBy: buildCatchByMap(container, route.catchBy, { owner, declaredBy: '"@CatchWith"' }),
        guards: compileRouteGuardChain(
          container,
          compiledGuards,
          exempt ? [] : globalGuards,
          spec.guards,
          route.guards,
          owner,
        ),
        hooks: compileHooks(spec.hooks, meta.hooks, route.hooks),
        authorization: (() => {
          if (exempt) {
            // The mark drops authorization, so a route asking for it as well would be served without it, silently.
            if (declaresAuthzProtection(route.authz)) {
              throw new ErrConfiguration(
                errMessage(`Cannot serve "${owner}": it is outside access control and declares authorization`)
                  .solutions(
                    'Remove accessControlExempt() from the route or its group',
                    'Remove authorize(...) from the route',
                  )
                  .reference('@caffeinejs/http', ErrConfiguration)
                  .build(),
              )
            }

            return { hasProtection: false, options: undefined, authorizer: undefined, schemes: [] }
          }

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
      catchBy: buildCatchByMap(container, spec.catchBy, { owner: meta.name, declaredBy: '"@CatchWith"' }),
      // Kept on the router rather than merged down: group-level metadata describes the group, and a reader
      // that wants both levels reads them separately rather than receiving one flattened bag.
      detail: spec.detail,
      boundTo: boundTo(spec.labels),
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
      errMessage(`Cannot compile route "${String(route.name)}": it declares no handler`)
        .solutions(
          'Set the function to call with "RouteBuilder.handle(fn)"',
          'Supply a dispatch for the route from the route source that declared it',
        )
        .reference('@caffeinejs/http', ErrConfiguration)
        .build(),
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
  compiledGuards: Map<InjectionToken<Guard>, CompiledGuard<Guard>>,
  globalGuards: readonly CompiledGuard<Guard>[],
  routerGuards: InjectionToken<Guard>[] | undefined,
  routeGuards: InjectionToken<Guard>[] | undefined,
  owner: string,
): readonly CompiledGuard<Guard>[] | undefined {
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
function dedupe(chain: CompiledGuard<Guard>[]): CompiledGuard<Guard>[] {
  return [...new Set(chain)]
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

/**
 * A route's hooks as it carries them: the group's, then the source's, then the route's own, point by point.
 * `undefined` when none of them has one.
 */
function compileHooks<R>(
  group: AuthoredHooks | undefined,
  source: CompiledHooks<R> | undefined,
  route: AuthoredHooks | undefined,
): CompiledHooks<R> | undefined {
  if (group === undefined && source === undefined && route === undefined) {
    return undefined
  }

  const compiled: Record<string, unknown[]> = {}
  let any = false

  // An authored hook takes the context and, at `onSend` and `onError`, one more argument: never the request.
  const authored = (fns: readonly unknown[] | undefined): unknown[] =>
    (fns ?? []).map(
      fn => (_req: R, ctx: unknown, arg: unknown) => (fn as (ctx: unknown, arg: unknown) => unknown)(ctx, arg),
    )

  for (const name of REQUEST_HOOK_NAMES) {
    const list = [...authored(group?.[name]), ...(source?.[name] ?? []), ...authored(route?.[name])]
    compiled[name] = list
    any ||= list.length > 0
  }

  return any ? (compiled as unknown as CompiledHooks<R>) : undefined
}
