import type { Feature, FeatureConfigurer } from '@caffeinejs/std'

import { AuthenticationBuilder } from './builder.js'

/**
 * The authentication feature: schemes, credentials, refresh tokens, and the services user code injects —
 * `AuthenticationService`, `JWTService`, `CredentialsService`, … — bound while the container is open.
 *
 * Binding is all it does. Requests are gated only where the application also registers the gate plugin,
 * `.with(authentication())`, or a scoped one with `router.plugin(authentication(g => g.name('admin')))`.
 * Installing the feature without a gate is a supported configuration: an application that only issues tokens,
 * or one that gates chosen routers alone. A route that requires authentication with no gate over it is not:
 * start-up refuses it with `ErrAuthenticationGateRequired`.
 *
 * ```ts
 * createWebApplication()
 *   .install(Authentication((a, { config }) => a.config(config.app.auth).addJWTBearer(j => j.secret(SECRET))))
 *   .with(authentication())
 * ```
 */
export function Authentication<C = unknown>(configure: FeatureConfigurer<AuthenticationBuilder<C>, C>): Feature<C> {
  return new AuthenticationBuilder<C>(configure as never)
}
