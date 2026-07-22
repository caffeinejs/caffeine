/**
 * Fetches a provider's user information endpoint with a bearer access token.
 *
 * Shared because both protocols need it for different reasons: OpenID Connect treats it as an
 * optional supplement to the id_token (Core §5.3), while a plain OAuth 2.0 provider has no
 * id_token at all and this is the only source of user claims.
 */
export async function fetchUserInfo(
  endpoint: string,
  accessToken: string,
  options: { timeoutMs: number, headers?: Record<string, string> },
): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(endpoint, {
      headers: {
        // Accept is a sensible default the caller may still override (a vendor media type).
        Accept: 'application/json',
        ...options.headers,
        // Authorization is spread last, so a caller-supplied header can never displace the
        // freshly exchanged per-request access token — doing so would resolve every user's
        // identity against whatever static token was configured, i.e. the same account.
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(options.timeoutMs),
    })
  } catch (e) {
    throw new Error(`user info request failed: ${(e as Error).message}`, { cause: e })
  }

  if (!response.ok) {
    throw new Error(`user info endpoint returned ${response.status}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (e) {
    throw new Error(`user info response is not JSON: ${(e as Error).message}`, { cause: e })
  }

  // A non-object body cannot carry claims, and indexing into one would silently yield
  // undefined for every field including the subject.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('user info response is not a JSON object')
  }

  return body as Record<string, unknown>
}
