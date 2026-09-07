export { Authentication } from './authentication_middleware.js'
export { AuthenticationState, SchemeAuthentication } from './authentication_state.js'
export { BasicAuthenticationHandler, type BasicAuthenticationOptions } from './basic/index.js'
export { AuthenticationBuilder } from './builder.js'
export { authConfigSchema, type AuthConfigSlice } from './config.js'
export {
  CookieAuthenticationHandler,
  type CookieAuthenticationOptions,
  CookieAuthenticationOptionsBuilder,
  type CookieSameSite,
  type RememberMeRecord,
  type RememberMeRotation,
  RememberMeTokenStore,
} from './cookie/index.js'
export {
  buildCredentialPrincipal,
  CredentialsService,
  type CredentialsServiceOptions,
  type CredentialUser,
  PasswordHasher,
  type ScryptParams,
  ScryptPasswordHasher,
  UserProvider,
} from './credentials/index.js'
export type { AuthSchemeDescriptor, AuthSchemeFlows } from './descriptor.js'
export { ErrAuthConfiguration, ErrAuthSchemeNotFound } from './errors.js'
export { type AuthenticationHandler, BaseAuthenticationHandler } from './handler.js'
export { JWTAuthenticationHandler, type JWTAuthenticationOptions, jwtServiceKey } from './jwt/index.js'
export {
  type JWTKeyContext,
  type JWTKeyResolver,
  JWTService,
  JWTServiceBuilder,
  type JWTServiceOptions,
  type JWTSignOptions,
} from './jwt/index.js'
export { kAuthContribution, kAuthSchemeDescriptors, kOIDCContribution } from './keys.js'
export {
  googleOIDCPreset,
  OIDCAuthenticationHandler,
  type OIDCAuthenticationOptions,
  OIDCAuthenticationOptionsBuilder,
  type RemoteAuthenticationSession,
  type RemoteAuthenticationTicket,
  type RemoteAuthenticationTicketStore,
  type RemoteChallengeMode,
} from './oidc/index.js'
export {
  OpaqueTokenAuthenticationHandler,
  type OpaqueTokenAuthenticationOptions,
  OpaqueTokenAuthenticationOptionsBuilder,
  OpaqueTokenStore,
} from './opaque/index.js'
export {
  ErrRefreshTokenRejected,
  type RefreshPrincipalResolver,
  type RefreshTokenOptions,
  RefreshTokenOptionsBuilder,
  type RefreshTokenPair,
  type RefreshTokenRecord,
  RefreshTokenService,
  RefreshTokenStore,
} from './refresh/index.js'
export { AuthenticationSchemeProvider } from './scheme_provider.js'
export { AuthenticationService } from './service.js'
export { AuthenticateResult, AuthenticationTicket } from './ticket.js'
