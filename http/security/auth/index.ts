export { AuthenticationState, SchemeAuthentication } from './authentication_state.js'
export {
  BasicAuthenticationHandler,
  type BasicAuthenticationOptions,
  BasicAuthenticationOptionsBuilder,
} from './basic/index.js'
export { AuthenticationBuilder } from './builder.js'
export { authConfigSchema, SCHEME_SCHEMAS, type AuthConfig } from './config.js'
export {
  CookieAuthenticationHandler,
  type CookieAuthenticationOptions,
  CookieAuthenticationOptionsBuilder,
  type CookieSameSite,
  REMEMBERED_CLAIM,
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
export {
  ErrAuthConfiguration,
  ErrAuthenticationCookies,
  ErrAuthenticationRequired,
  ErrAuthSchemeNotFound,
} from './errors.js'
export { type AuthenticationHandler, BaseAuthenticationHandler } from './handler.js'
export { isSafeReturnPath } from './internal/remote/config.js'
export {
  JWTAuthenticationHandler,
  type JWTAuthenticationOptions,
  JWTAuthenticationOptionsBuilder,
  jwtServiceKey,
} from './jwt/index.js'
export {
  type JWTKeyContext,
  type JWTKeyResolver,
  JWTService,
  JWTServiceBuilder,
  type JWTServiceOptions,
  type JWTSignOptions,
} from './jwt/index.js'
export { kAuthenticationExempt, kAuthSchemeDescriptors } from './keys.js'
export {
  OAuth2AuthenticationHandler,
  type OAuth2AuthenticationOptions,
  OAuth2AuthenticationOptionsBuilder,
} from './oauth/index.js'
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
  RefreshTokenService,
  RefreshTokenStore,
} from './refresh/index.js'
export { AuthenticationSchemeProvider } from './scheme_provider.js'
export { type SeriesTokenRecord, type SeriesTokenRotation, SeriesTokenStore } from './internal/series_token.js'
export { AuthenticationService } from './service.js'
export { AuthenticateResult, AuthenticationTicket } from './ticket.js'
