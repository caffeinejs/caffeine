import type { FastifyReply, FastifyRequest } from 'fastify'
import { FeatureConfigurer, type RoutePhaseContext, type ServerPhaseContext } from '../../feature_configurer.js'

/**
 * Enforces per-route authorization. Validates at start-up that authorization is not configured without
 * authentication, then pushes an `onRequest` guard on every protected route that delegates
 * challenge/forbid to the authentication coordinator.
 */
export class AuthorizationConfigurer extends FeatureConfigurer {
  readonly name = 'authorization'
  readonly after = ['authentication']

  configureServer = (ctx: ServerPhaseContext): void => {
    const anyRouteNeedsAuthz = ctx.routers.some(r => r.routes.some(rt => rt.authorization.hasProtection))
    if (anyRouteNeedsAuthz && !ctx.services.auth.enabled) {
      throw new Error('Cannot start application: authorization is configured but authentication is not')
    }
  }

  configureRoute = (ctx: RoutePhaseContext): void => {
    const authorizer = ctx.route.authorization.authorizer
    if (authorizer == null) {
      return
    }

    const coordinator = ctx.services.auth.coordinator!
    const onRequest = ctx.routeDef.onRequest as Array<(req: FastifyRequest, reply: FastifyReply) => Promise<void>>

    onRequest.push(async (req, reply) => {
      const c = req.httpContext
      const result = await authorizer.authorize(c, req.user)
      if (result.ok) {
        return
      }

      if (!c.user.authenticated) {
        await coordinator.challenge(c)
      } else {
        await coordinator.forbid(c)
      }

      // challenge()/forbid() only set status/headers (or a redirect); they do not end the request.
      // Finalize here so the route handler is skipped — otherwise it runs despite the failed check.
      if (!reply.sent) {
        await reply.send()
      }
    })
  }
}
