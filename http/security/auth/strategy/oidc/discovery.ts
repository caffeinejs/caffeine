import { ErrOidcDiscovery } from './errors.js'
import { assertSecureEndpoint } from './options.js'

export interface OidcDiscoveryDocument {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  userinfo_endpoint?: string
  code_challenge_methods_supported?: string[]
  /** OIDC Discovery §3: when absent, the default is `client_secret_basic`. */
  token_endpoint_auth_methods_supported?: string[]
}

const WELL_KNOWN = '/.well-known/openid-configuration'

const REQUIRED_FIELDS = ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const

export async function fetchDiscovery(
  discoveryUrl: string,
  timeoutMs = 5000,
): Promise<OidcDiscoveryDocument> {
  const url = discoveryUrl.endsWith(WELL_KNOWN)
    ? discoveryUrl
    : `${discoveryUrl.replace(/\/$/, '')}${WELL_KNOWN}`

  let response: Response
  try {
    // Without a deadline a hung provider pins the request for as long as it likes.
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    throw new ErrOidcDiscovery(`Cannot fetch OIDC discovery document: "${url}": ${(e as Error).message}`)
  }

  if (!response.ok) {
    throw new ErrOidcDiscovery(`Cannot fetch OIDC discovery document: "${url}" returned ${response.status}`)
  }

  let doc: OidcDiscoveryDocument
  try {
    doc = await response.json() as OidcDiscoveryDocument
  } catch (e) {
    throw new ErrOidcDiscovery(`Cannot parse OIDC discovery document: "${url}": ${(e as Error).message}`)
  }

  for (const field of REQUIRED_FIELDS) {
    if (typeof doc[field] !== 'string' || doc[field].length === 0) {
      throw new ErrOidcDiscovery(`Cannot use OIDC discovery document: "${url}" is missing "${field}"`)
    }
  }

  // The document is remote input: its endpoints must satisfy the same TLS rule as
  // endpoints supplied through configuration.
  assertSecureEndpoint('issuer', doc.issuer)
  assertSecureEndpoint('authorization_endpoint', doc.authorization_endpoint)
  assertSecureEndpoint('token_endpoint', doc.token_endpoint)
  assertSecureEndpoint('jwks_uri', doc.jwks_uri)

  return doc
}
