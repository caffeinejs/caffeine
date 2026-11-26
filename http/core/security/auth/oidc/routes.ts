import { errMessage } from '@caffeinejs/std/err'

import { stripBasePath } from '../../../../base_path.js'
import type { HTTPSetupContext } from '../../../../plugin.js'
import { isServerScope } from '../../../../plugin_slot.js'
import { Router } from '../../../routing/programmatic/programmatic.js'
import { accessControlExempt } from '../../exempt.js'
import { ErrAuthConfiguration } from '../errors.js'
import { isRemoteAuthenticationError } from '../internal/remote/errors.js'
import { OIDC_ROUTE, type OIDCMeta } from './oidc.js'

/**
 * Where a browser path of the OIDC routes is routed. Both paths are the browser's — the callback's comes from
 * `callbackURL` — so they carry the application's base path, which the server takes off a request before routing
 * it. The routes go where the stripped request lands.
 */
export function routedPath(path: string, basePath: string): string {
  return basePath === '' ? path : (stripBasePath(path, basePath) ?? path)
}

/** What a route at an OIDC route's path is refused with. */
export function oidcConflict(url: string): string {
  return `Cannot start application: the OIDC callback or login path "${url}" conflicts with a registered controller route`
}

/**
 * The strategies that can never authenticate a request: neither the default, nor selectable through a Forward
 * default, nor named by any route in `named`.
 */
export function unreachableStrategies(oidc: OIDCMeta, named: ReadonlySet<string>): string[] {
  return oidc.unreachableCandidates.filter(name => !named.has(name))
}

/** The warning for strategies {@link unreachableStrategies} found: a warning, not a start-up failure. */
export function unreachableText(names: readonly string[]): { readonly message: string; readonly detail: string } {
  // A warning, not a failure: two OAuth strategies are reachable when each route names its own scheme, as
  // `/login/google` and `/login/github` do, and only the registered routes carry those names.
  return {
    message:
      `OAuth strategies ${names.map(n => `"${n}"`).join(', ')} can never authenticate a request: ` +
      'they are not the default authenticate scheme and no route names them',
    detail:
      'Name the scheme on a route with @Authorize({ schemes: [...] }), make it the default, ' +
      'or use a Forward default to select per request.',
  }
}

/**
 * What a failed callback answers. Every failure mode looks identical to a client probing the callback: the
 * diagnostic detail (state, nonce, signature, token exchange) stays in the logs.
 */
export function callbackFailure(err: unknown): {
  readonly status: number
  readonly body: { readonly error: string; readonly statusCode: number }
} {
  const status = isRemoteAuthenticationError(err) ? err.statusCode : 400
  const error = isRemoteAuthenticationError(err) ? err.publicMessage : 'Authentication failed'

  return { status, body: { error, statusCode: status } }
}

/**
 * Serves each strategy's sign-in and callback routes in the scope `context.server` is, as a router outside access
 * control, and refuses a route of that scope at either path. Each is served at its own path: under a router or a
 * controller, that path must start with the scope's.
 *
 * Both are where a user who is not signed in yet arrives — sent back by the identity provider, or on the way to
 * it — so they stand outside the gate and the fallback policy. Under a router or a controller, the guards it declares
 * cover them as they cover its other routes.
 *
 * @throws ErrAuthConfiguration when a path is outside the scope, where the identity provider's redirect never lands.
 */
export function mountOIDCRoutes(context: HTTPSetupContext, oidc: OIDCMeta): void {
  const { basePath, prefix } = context.server
  const routed = (path: string): string => routedPath(path, basePath)
  // What the router below mounts nests under the scope's prefix: each path relative to it.
  const local = (path: string): string => {
    const at = routed(path)
    const within = prefix === '' ? at : stripBasePath(at, prefix)
    if (within === undefined) {
      throw new ErrAuthConfiguration(
        errMessage(`Cannot serve the OIDC route "${at}" from a gate under "${prefix}": the path is outside it`)
          .solutions(
            'Give the strategy a callback and a sign-in path under that path with "callbackURL(...)" and "loginPath(...)"',
            'Or register a gate on the server, which serves them at any path',
            'Or turn them off on this gate: "authentication(g => g.oidcRoutes(false))"',
          )
          .reference('@caffeinejs/http', ErrAuthConfiguration)
          .build(),
      )
    }

    return within
  }
  const ownPaths = new Set(
    oidc.handlers.flatMap(({ callbackPath, handler }) => [routed(callbackPath), routed(handler.loginPath)]),
  )
  const paths = oidc.handlers.map(({ callbackPath, handler }) => ({
    callback: local(callbackPath),
    login: local(handler.loginPath),
  }))
  const named = new Set<string>()

  context.server.hook('onRoute', route => {
    if (route.options.oidcRoute === OIDC_ROUTE) {
      return
    }

    if (ownPaths.has(route.url)) {
      throw new ErrAuthConfiguration(
        errMessage(oidcConflict(route.url))
          .solutions(
            'Move the route to another path',
            'Or give the strategy another callback with "callbackURL(...)"',
            'Or give the strategy another sign-in path with "loginPath(...)"',
          )
          .reference('@caffeinejs/http', ErrAuthConfiguration)
          .build(),
      )
    }

    for (const scheme of route.route.authorization.options?.schemes ?? []) {
      named.add(scheme)
    }
  })

  context.server.hook('onReady', () => {
    // A gate on a router or a controller sees that one's routes alone: a route elsewhere may name a scheme it cannot
    // see, so only a gate that sees every route of its server warns.
    if (!isServerScope(context.server)) {
      return
    }

    const unreachable = unreachableStrategies(oidc, named)
    if (unreachable.length > 0) {
      const { message, detail } = unreachableText(unreachable)
      context.logger.warn({ detail }, message)
    }
  })

  const router = new Router()
    .detail('http', { internal: true })
    .config(accessControlExempt(), { oidcRoute: OIDC_ROUTE })

  for (const [at, { handler }] of oidc.handlers.entries()) {
    // A failure here — the provider cannot be reached — goes to the error handlers, which answer with the error's
    // public message.
    router.get(paths[at]!.login).handler(async ctx => {
      await handler.startSignIn(ctx)
    })
  }

  for (const [at, { handler }] of oidc.handlers.entries()) {
    router.get(paths[at]!.callback).handler(async ctx => {
      try {
        await handler.processCallback(ctx)
        return undefined
      } catch (e) {
        context.logger.error({ reqId: ctx.req.id, err: e }, 'OIDC callback failed')

        // The strategy's `onFail` has run by now and may have answered, usually by sending the user to a page that
        // says the sign-in did not work. What it answered stands, whether it sent it or left a redirect to be sent.
        if (ctx.sent) {
          return undefined
        }

        if (ctx.statusCode >= 300 && ctx.statusCode < 400) {
          ctx.body()
          return undefined
        }

        const { status, body } = callbackFailure(e)
        ctx.status(status)
        return body
      }
    })
  }

  context.server.mount(router)
}
