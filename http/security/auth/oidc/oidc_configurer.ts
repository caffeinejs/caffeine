import { FeatureConfigurer, type ServerPhaseContext } from '../../../feature_configurer.js'
import { joinPaths } from '../../../internal/paths/index.js'
import { isOIDCError } from './index.js'

/**
 * Registers the OIDC/OAuth2 callback routes, validates their paths do not collide with controller
 * routes, and asserts `@fastify/cookie` is present at start-up. Only active when OIDC is configured.
 */
export class OIDCConfigurer extends FeatureConfigurer {
  readonly name = 'oidc'

  configureServer = (ctx: ServerPhaseContext): void => {
    const oidc = ctx.services.oidc
    if (!oidc) {
      return
    }

    const server = ctx.server
    const compiledPaths = new Set(
      ctx.routers.flatMap(r => r.routes.map(rt => joinPaths(r.path, rt.path))),
    )

    for (const { callbackPath } of oidc.handlers) {
      if (compiledPaths.has(callbackPath)) {
        throw new Error(
          `Cannot start application: OIDC callbackPath "${callbackPath}" conflicts with a registered controller route`,
        )
      }
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
}
