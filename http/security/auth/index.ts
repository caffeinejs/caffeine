export { BasicAuthenticationHandler, type BasicAuthenticationOptions } from './basic/index.js'
export { AuthenticationBuilder } from './builder.js'
export {
  CookieAuthenticationHandler,
  type CookieAuthenticationOptions,
  CookieAuthenticationOptionsBuilder,
  type CookieSameSite,
  type RememberMeRecord,
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
export { kOIDCMeta } from './keys.js'
export {
  googleOIDCPreset,
  OIDCAuthenticationHandler,
  type OIDCAuthenticationOptions,
  OIDCAuthenticationOptionsBuilder,
  type RemoteAuthenticationSession,
  type RemoteAuthenticationTicket,
  type RemoteAuthenticationTicketStore,
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
export { AuthenticationService } from './service.js'
export { AuthenticateResult, AuthenticationTicket } from './ticket.js'
