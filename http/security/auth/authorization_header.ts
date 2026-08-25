/**
 * Extracts the credentials from an `Authorization` header for a given scheme.
 *
 * The scheme token is matched case-insensitively, because RFC 7235 §2.1 defines it that way and clients
 * act on it: `bearer <token>` and `BEARER <token>` are as valid on the wire as `Bearer <token>`, and a
 * case-sensitive `startsWith` rejects them as though no credential had been presented at all — a 401 with
 * nothing to point at. ASP.NET compares with `StringComparison.OrdinalIgnoreCase` throughout.
 *
 * Returns `undefined` when the header is absent or names a different scheme, which callers treat as "no
 * credential offered" rather than as a failure — another scheme may still authenticate this request. An
 * empty credential is `undefined` too: a bare `Authorization: Bearer` carries nothing to verify.
 */
export function parseAuthorizationHeader(header: string | undefined, scheme: string): string | undefined {
  if (header === undefined) {
    return undefined
  }

  // The separator is a single space per the grammar, but leading whitespace is tolerated the way every
  // other header parser does, and the credential itself is trimmed of trailing whitespace.
  const separator = header.indexOf(' ')
  if (separator === -1) {
    return undefined
  }

  if (header.slice(0, separator).toLowerCase() !== scheme.toLowerCase()) {
    return undefined
  }

  const credentials = header.slice(separator + 1).trim()
  return credentials.length === 0 ? undefined : credentials
}
