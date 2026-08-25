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

    // A route that names schemes must be challenged by those, not by the application default. Otherwise a
    // Basic-protected route in a browser-first application answers with the default scheme's redirect,
    // which an API client can neither follow nor satisfy. Every named scheme gets to contribute, as
    // ASP.NET's authorization middleware does over `policy.AuthenticationSchemes`: each writes its own
    // `WWW-Authenticate`, so a route accepting Basic or Bearer advertises both instead of whichever the
    // decorator happened to list first. An unnamed route passes `undefined` and gets the default.
    const schemes = ctx.route.authorization.options?.schemes
    const challenged: Array<string | undefined> = schemes?.length ? schemes : [undefined]

    onRequest.push(async (req, reply) => {
      const c = req.httpContext
      const result = await authorizer.authorize(c, req.user)
      if (result.ok) {
        return
      }

      if (!c.user.authenticated) {
        for (const scheme of challenged) {
          await coordinator.challenge(c, scheme)
        }
      } else {
        // Forbid is a single decision, not an advertisement: the caller is authenticated and simply not
        // permitted, so repeating it per scheme would just overwrite one 403 with another.
        await coordinator.forbid(c, challenged[0])
      }

      // challenge()/forbid() only set status/headers (or a redirect); they do not end the request.
      // Finalize here so the route handler is skipped — otherwise it runs despite the failed check.
      if (!reply.sent) {
        await reply.send()
      }
    })
  }
}
