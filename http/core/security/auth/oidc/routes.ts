import { errMessage } from '@caffeinejs/std/err'

import { stripBasePath } from '../../../../base_path.js'
import type { HTTPSetupContext } from '../../../../plugin.js'
import { Router } from '../../../routing/programmatic/programmatic.js'
import { ACCESS_CONTROL_EXEMPT, kAccessControlExempt } from '../../exempt.js'
import { ErrAuthConfiguration } from '../errors.js'
import { isRemoteAuthenticationError } from '../internal/remote/errors.js'
import type { OIDCMeta } from './oidc.js'

/** Marks the OIDC routes the engine serves, so the conflict check passes over them. */
const kOIDCRoute = 'caffeine:oidc-route'
const OIDC_ROUTE: unique symbol = Symbol('caffeine.http.oidc-route')

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
 * Serves each strategy's sign-in and callback routes on the engine, as a router outside access control, and
 * refuses a route of the application at either path.
 *
 * Both are where a user who is not signed in yet arrives — sent back by the identity provider, or on the way to
 * it — so no gate, guard or fallback policy may stand in front of them.
 */
export function mountOIDCRoutes(context: HTTPSetupContext, oidc: OIDCMeta, basePath: string): void {
  const routed = (path: string): string => routedPath(path, basePath)
  const ownPaths = new Set(
    oidc.handlers.flatMap(({ callbackPath, handler }) => [routed(callbackPath), routed(handler.loginPath)]),
  )
  const named = new Set<string>()

  context.app.hook('onRoute', route => {
    if (route.config.get(kOIDCRoute) === OIDC_ROUTE) {
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

  context.app.hook('onReady', () => {
    const unreachable = unreachableStrategies(oidc, named)
    if (unreachable.length > 0) {
      const { message, detail } = unreachableText(unreachable)
      context.logger.warn({ detail }, message)
    }
  })

  const router = new Router()
    .detail('http', { internal: true })
    .config(kAccessControlExempt, ACCESS_CONTROL_EXEMPT)
    .config(kOIDCRoute, OIDC_ROUTE)

  for (const { handler } of oidc.handlers) {
    // A failure here — the provider cannot be reached — goes to the error handlers, which answer with the error's
    // public message.
    router.get(routed(handler.loginPath)).handler(async ctx => {
      await handler.startSignIn(ctx)
    })
  }

  for (const { callbackPath, handler } of oidc.handlers) {
    router.get(routed(callbackPath)).handler(async ctx => {
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

  context.app.mount(router)
}
