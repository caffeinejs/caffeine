/**
 * How a client authenticates to the token endpoint.
 *
 * RFC 6749 §2.3.1 requires servers to support `client_secret_basic` and calls credentials in the request body
 * "NOT RECOMMENDED", for clients that cannot use the header.
 */
export type TokenEndpointAuthMethod = 'client_secret_basic' | 'client_secret_post'

/**
 * Builds the HTTP Basic credentials for token endpoint client authentication.
 *
 * RFC 6749 §2.3.1 requires both the client id and secret to be form-urlencoded *before* being joined and
 * base64-encoded.
 */
export function basicAuthHeader(clientID: string, clientSecret: string): string {
  const credentials = `${formURLEncode(clientID)}:${formURLEncode(clientSecret)}`
  return `Basic ${Buffer.from(credentials).toString('base64')}`
}

/**
 * Encodes a value with the `application/x-www-form-urlencoded` serializer.
 *
 * Uses `URLSearchParams` rather than `encodeURIComponent`, which leaves `!~'()` unencoded and would produce
 * credentials a strict authorization server rejects.
 */
function formURLEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2)
}
