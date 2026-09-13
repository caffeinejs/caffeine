import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

import { joinPaths } from '../../../internal/paths/index.js'
import type { HTTPPlugin } from '../../../plugin.js'
import { isOIDCError, type OIDCMeta } from './index.js'

/**
 * Registers the OIDC/OAuth2 callback routes.
 *
 * Contributed by the authentication builder only when an OIDC strategy was configured, so there is no "is it
 * on" question to answer here — the absence of this plugin is the answer.
 */
export function oidcRoutesPlugin(meta: OIDCMeta): HTTPPlugin {
  const plugin: HTTPPlugin = async instance => {
    installOIDCRoutes(instance, meta)
  }

  return fp(plugin, { name: 'caffeine-oidc-routes' })
}

/**
 * Registers the callback routes, validates their paths do not collide with controller routes, and asserts
 * `@fastify/cookie` is present at start-up.
 *
 * The cookie check is hand-rolled rather than declared as a Fastify plugin `decorators` requirement on
 * purpose: Fastify's assertion names the missing decorator (`cookies`), while this one names the package
 * the user has to install and register.
 */
export function installOIDCRoutes(server: FastifyInstance, oidc: OIDCMeta): void {
  const compiledPaths = new Set(server.$routeGroups.flatMap(r => r.routes.map(rt => joinPaths(r.path, rt.path))))

  for (const { callbackPath } of oidc.handlers) {
    if (compiledPaths.has(callbackPath)) {
      throw new Error(
        `Cannot start application: OIDC callbackPath "${callbackPath}" conflicts with a registered controller route`,
      )
    }
  }

  // A strategy that is neither the default, nor selectable through a Forward default, nor named by any
  // route authenticates nobody: it registers a callback route and silently never signs anyone in.
  //
  // A warning, not a failure. This used to be a hard error demanding a Forward default whenever two
  // OAuth strategies were registered, which rejected the configuration that makes them reachable —
  // `/login/google` and `/login/github`, each naming its own scheme. Only the resolved routing carries
  // those names, which is why the decision lands here rather than in the builder.
  const namedByRoutes = new Set(
    server.$routeGroups.flatMap(r => r.routes.flatMap(rt => rt.authorization.options?.schemes ?? [])),
  )
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

  server.addHook('onReady', async () => {
    if (!server.hasRequestDecorator('cookies')) {
      throw new Error('Cannot start application: OIDC authentication requires @fastify/cookie to be registered')
    }
  })

  for (const { callbackPath, handler } of oidc.handlers) {
    server.get(callbackPath, async (req, reply) => {
      try {
        await handler.processCallback(req.httpContext)
      } catch (e) {
        // Diagnostic detail (state, nonce, signature, token exchange) stays in the logs: every
        // failure mode must look identical to a client probing the callback.
        req.log.error({ err: e }, 'OIDC callback failed')
        const status = isOIDCError(e) ? e.statusCode : 400
        const error = isOIDCError(e) ? e.publicMessage : 'Authentication failed'
        return reply.status(status).send({ error, statusCode: status })
      }
    })
  }
}
