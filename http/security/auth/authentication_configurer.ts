import { FeatureConfigurer, type RouterPhaseContext } from '../../feature_configurer.js'
import { newAnonymousUser, type Principal } from '../index.js'

/**
 * Authenticates each request inside every controller scope, populating `req.user`. Runs the default
 * authenticate scheme; a successful result's identities are merged onto the principal.
 */
export class AuthenticationConfigurer extends FeatureConfigurer {
  readonly name = 'authentication'

  configureRouter = (ctx: RouterPhaseContext): void => {
    const auth = ctx.services.auth
    if (!auth.enabled || !auth.coordinator || !auth.options) {
      return
    }

    const coordinator = auth.coordinator
    const schemes = auth.options.defaultAuthenticateScheme ? [auth.options.defaultAuthenticateScheme] : []
    if (schemes.length === 0) {
      return
    }

    ctx.server.addHook('onRequest', async req => {
      let user: Principal | null = null
      for (const scheme of schemes) {
        const result = await coordinator.authenticate(req.httpContext, scheme)
        if (result.succeeded) {
          if (user) {
            for (const identity of result.ticket!.principal.identities) {
              user.addIdentity(identity)
            }
          } else {
            user = result.ticket!.principal
          }
        }
      }
      req.user = user ?? newAnonymousUser()
    })
  }
}
