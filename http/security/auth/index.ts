export { BasicAuthenticationHandler, type BasicAuthenticationOptions } from './basic/index.js'
export { AuthenticationBuilder } from './builder.js'
export { type AuthenticationHandler, BaseAuthenticationHandler } from './handler.js'
export { JWTAuthenticationHandler, type JWTAuthenticationOptions } from './jwt/index.js'
export {
  googleOIDCPreset,
  OIDCAuthenticationHandler,
  type OIDCAuthenticationOptions,
  OIDCAuthenticationOptionsBuilder,
  type RemoteAuthenticationSession,
  type RemoteAuthenticationTicket,
  type RemoteAuthenticationTicketStore,
} from './oidc/index.js'
export { AuthenticationService } from './service.js'
export { AuthenticateResult, AuthenticationTicket } from './ticket.js'
