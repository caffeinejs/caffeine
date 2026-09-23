import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import { authenticationExempt } from '../../../fastify_route_config.js'
import { isRemoteAuthenticationError } from '../internal/remote/errors.js'
import type { OIDCMeta } from './index.js'

/**
 * Registers the OIDC/OAuth2 callback routes.
 *
 * Contributed by the authentication builder only when an OIDC strategy was configured, so there is no "is it
 * on" question to answer here — the absence of this plugin is the answer.
 */
export function oidcRoutesPlugin(meta: OIDCMeta): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    installOIDCRoutes(instance, meta)
  }

  return fp(plugin, { name: 'caffeine-oidc-routes' })
}

/**
 * Registers each strategy's callback and sign-in routes and validates their paths do not collide with controller
 * routes.
 *
 * Both are where a user who is not signed in yet arrives — sent back by the identity provider, or on the way to
 * it — so they are marked {@link authenticationExempt}: no fallback policy may stand in front of them.
 */
export function installOIDCRoutes(server: FastifyInstance, oidc: OIDCMeta): void {
  const ownPaths = new Set(oidc.handlers.flatMap(({ callbackPath, handler }) => [callbackPath, handler.loginPath]))
  const namedByRoutes = new Set<string>()

  // Compiled routes register after the callback routes, so each is checked as it registers.
  server.addHook('onRoute', route => {
    const meta = route.config?.$caffeine?.compiled
    if (meta === undefined) {
      return
    }

    if (ownPaths.has(route.url)) {
      throw new Error(
        `Cannot start application: the OIDC callback or login path "${route.url}" conflicts with a registered controller route`,
      )
    }

    for (const scheme of meta.route.authorization.options?.schemes ?? []) {
      namedByRoutes.add(scheme)
    }
  })

  server.addHook('onReady', async () => {
    // A strategy that is neither the default, nor selectable through a Forward default, nor named by any
    // route authenticates nobody: it registers a callback route and silently never signs anyone in.
    //
    // A warning, not a failure. This used to be a hard error demanding a Forward default whenever two
    // OAuth strategies were registered, which rejected the configuration that makes them reachable —
    // `/login/google` and `/login/github`, each naming its own scheme. Only the registered routes carry
    // those names, which is why the decision lands here rather than in the builder.
    const unreachable = oidc.unreachableCandidates.filter(name => !namedByRoutes.has(name))
    if (unreachable.length > 0) {
      process.emitWarning(
        `OAuth strategies ${unreachable.map(n => `"${n}"`).join(', ')} can never authenticate a request: ` +
          'they are not the default authenticate scheme and no route names them',
        {
          type: 'CaffeineAuthenticationWarning',
          detail:
            'Name the scheme on a route with @Authorize({ schemes: [...] }), make it the default, ' +
            'or use a Forward default to select per request.',
        },
      )
    }
  })

  for (const { handler } of oidc.handlers) {
    // A failure here — the provider cannot be reached — goes to the application-wide error handler, which answers
    // with the error's public message.
    server.get(handler.loginPath, { config: authenticationExempt() }, async req => {
      await handler.startSignIn(req.httpContext)
    })
  }

  for (const { callbackPath, handler } of oidc.handlers) {
    server.get(callbackPath, { config: authenticationExempt() }, async (req, reply) => {
      try {
        await handler.processCallback(req.httpContext)
      } catch (e) {
        // Diagnostic detail (state, nonce, signature, token exchange) stays in the logs: every
        // failure mode must look identical to a client probing the callback.
        req.log.error({ err: e }, 'OIDC callback failed')

        // The strategy's `onFail` has run by now and may have answered, usually by sending the user to a page that
        // says the sign-in did not work. What it answered stands, whether it sent it or left a redirect to be sent.
        // Asked of the context: `reply.sent` is still false while an `onSend` hook holds that send open.
        if (req.httpContext.sent) {
          return reply
        }

        if (reply.statusCode >= 300 && reply.statusCode < 400) {
          return reply.send()
        }

        const status = isRemoteAuthenticationError(e) ? e.statusCode : 400
        const error = isRemoteAuthenticationError(e) ? e.publicMessage : 'Authentication failed'
        return reply.status(status).send({ error, statusCode: status })
      }
    })
  }
}
