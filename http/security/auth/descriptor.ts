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
  /**
   * How the credential **travels** on a request the handler will accept.
   *
   * Transport only, and independent of how the credential was obtained. An OAuth 2.0 or OpenID Connect
   * sign-in that ends in a session cookie is `apiKey` here, not `oauth2`: the handler reads a cookie and
   * would reject the bearer token an `oauth2` scheme promises. `flows` and `openIdConnectURL` are what
   * record the sign-in, and they are set alongside whichever `kind` the transport really is.
   */
  kind: 'http' | 'apiKey' | 'openIdConnect' | 'oauth2'
  /** For `http`: the `Authorization` scheme keyword, lowercased — `bearer`, `basic`. */
  scheme?: string
  /** For `http` bearer tokens: the token format, when it is known to be one — `JWT`. */
  bearerFormat?: string
  /** For `apiKey`: where the credential is read from. */
  in?: 'header' | 'query' | 'cookie'
  /** For `apiKey`: the header, query parameter, or cookie name carrying the credential. */
  name?: string
  /** The OpenID Connect discovery document the credential is obtained through, when there is one. */
  openIdConnectURL?: string
  /** The OAuth 2.0 flow the credential is obtained through, when there is one. */
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
