/**
 * A vendor-neutral description of how a registered authentication scheme expects to be presented with
 * credentials — the transport, not the verification.
 *
 * It exists so a package outside http (documentation generators, client scaffolders) can describe the schemes an
 * application registered without importing the handlers or knowing what a `JWTAuthenticationHandler` is. The
 * vocabulary deliberately matches what every such consumer already needs; it is not an OpenAPI type, and http does
 * not depend on OpenAPI to produce it.
 *
 * Recorded at builder time, while the handler is constructed, so nothing has to resolve a `Provider` to read one.
 */
export interface AuthSchemeDescriptor {
  /** How the credential travels: an HTTP authentication scheme, an API key, OpenID Connect, or OAuth 2.0. */
  kind: 'http' | 'apiKey' | 'openIdConnect' | 'oauth2'
  /** For `http`: the `Authorization` scheme keyword, lowercased — `bearer`, `basic`. */
  scheme?: string
  /** For `http` bearer tokens: the token format, when it is known to be one — `JWT`. */
  bearerFormat?: string
  /** For `apiKey`: where the credential is read from. */
  in?: 'header' | 'query' | 'cookie'
  /** For `apiKey`: the header, query parameter, or cookie name carrying the credential. */
  name?: string
  /** For `openIdConnect`: the discovery document URL, when the scheme was configured with one. */
  openIdConnectURL?: string
  /** For `oauth2`: the authorization-code endpoints and the scopes the scheme requests. */
  flows?: AuthSchemeFlows
  /** Human-readable note about the scheme, when the registration implies something worth saying. */
  description?: string
}

/** The OAuth 2.0 flows a scheme supports. Only the authorization-code flow is derivable today. */
export interface AuthSchemeFlows {
  authorizationCode?: {
    authorizationURL: string
    tokenURL: string
    refreshURL?: string
    scopes?: readonly string[]
  }
}
