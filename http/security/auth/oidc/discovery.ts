import { DEFAULT_HTTP_TIMEOUT_MS } from '../internal/remote/config.js'
import { ErrOIDCDiscovery } from './errors.js'
import { assertSecureEndpoint } from './options.js'

export interface OIDCDiscoveryDocument {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  userinfo_endpoint?: string
  /** OpenID Connect RP-Initiated Logout §2: where to send the user to end the IdP session. */
  end_session_endpoint?: string
  code_challenge_methods_supported?: string[]
  /** OIDC Discovery §3: when absent, the default is `client_secret_basic`. */
  token_endpoint_auth_methods_supported?: string[]
  /**
   * RFC 9207 §3: the provider returns `iss` on the authorization response.
   *
   * When `true`, the callback requires it — a provider that advertises the parameter and then
   * omits it is either misbehaving or being impersonated.
   */
  authorization_response_iss_parameter_supported?: boolean
}

const WELL_KNOWN = '/.well-known/openid-configuration'

const REQUIRED_FIELDS = ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const

/** Capability fields that must be arrays of strings when a provider advertises them. */
const STRING_ARRAY_FIELDS = ['code_challenge_methods_supported', 'token_endpoint_auth_methods_supported'] as const

export async function fetchDiscovery(
  discoveryURL: string,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
): Promise<OIDCDiscoveryDocument> {
  const url = discoveryURL.endsWith(WELL_KNOWN) ? discoveryURL : `${discoveryURL.replace(/\/$/, '')}${WELL_KNOWN}`

  let response: Response
  try {
    // Without a deadline a hung provider pins the request for as long as it likes.
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    throw new ErrOIDCDiscovery(`Cannot fetch OIDC discovery document: "${url}": ${(e as Error).message}`, {
      unreachable: true,
    })
  }

  if (!response.ok) {
    throw new ErrOIDCDiscovery(`Cannot fetch OIDC discovery document: "${url}" returned ${response.status}`, {
      unreachable: true,
    })
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (e) {
    throw new ErrOIDCDiscovery(`Cannot parse OIDC discovery document: "${url}": ${(e as Error).message}`, {
      unreachable: true,
    })
  }

  // Every field access below assumes an object. A body of literal `null`, an array, or a
  // string is valid JSON that would otherwise throw a bare TypeError at the first `doc[field]`,
  // outside any catch — a compromised or misconfigured discovery endpoint is in scope here.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ErrOIDCDiscovery(`Cannot use OIDC discovery document: "${url}" is not a JSON object`)
  }
  const doc = body as OIDCDiscoveryDocument

  for (const field of REQUIRED_FIELDS) {
    if (typeof doc[field] !== 'string' || doc[field].length === 0) {
      throw new ErrOIDCDiscovery(`Cannot use OIDC discovery document: "${url}" is missing "${field}"`)
    }
  }

  // Advertised as arrays and consumed with .includes()/.join(); a non-array value would throw
  // a bare TypeError in selectPKCEMethod or the token-auth negotiation rather than surface as a
  // typed discovery error.
  for (const field of STRING_ARRAY_FIELDS) {
    const value = doc[field]
    if (value !== undefined && (!Array.isArray(value) || value.some(s => typeof s !== 'string'))) {
      throw new ErrOIDCDiscovery(`Cannot use OIDC discovery document: "${url}" has a malformed "${field}"`)
    }
  }

  // The document is remote input: its endpoints must satisfy the same TLS rule as
  // endpoints supplied through configuration.
  assertSecureEndpoint('issuer', doc.issuer)
  assertSecureEndpoint('authorization_endpoint', doc.authorization_endpoint)
  assertSecureEndpoint('token_endpoint', doc.token_endpoint)
  assertSecureEndpoint('jwks_uri', doc.jwks_uri)
  // Optional in the document, but checked whenever present: the UserInfo request carries the
  // access token in an Authorization header, so plain http would hand it to the network.
  if (doc.userinfo_endpoint) {
    assertSecureEndpoint('userinfo_endpoint', doc.userinfo_endpoint)
  }
  // The logout request carries the id_token as `id_token_hint`.
  if (doc.end_session_endpoint) {
    assertSecureEndpoint('end_session_endpoint', doc.end_session_endpoint)
  }

  return doc
}
