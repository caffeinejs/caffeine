import type { AuthenticationBuilder } from '@caffeinejs/http'

/**
 * The option builders `addJWTBearer`, `addBasic` and `addOAuth2` hand to their callback.
 *
 * Read off the method signatures because `@caffeinejs/http` does not export these three by name, unlike the
 * cookie, OpenID Connect and opaque-token ones. A spec needs the name to write a configuration once and reuse it.
 */
export type JWTOptionsBuilder = Parameters<Parameters<AuthenticationBuilder['addJWTBearer']>[1]>[0]
export type BasicOptionsBuilder = Parameters<Parameters<AuthenticationBuilder['addBasic']>[1]>[0]
export type OAuth2OptionsBuilder = Parameters<Parameters<AuthenticationBuilder['addOAuth2']>[1]>[0]
