import type { JWSHeaderParameters, JWTPayload, KeyLike } from 'jose'

// Chooses a key per operation — enables rotation, JWKS, or per-tenant keys. A resolver may delegate to
// jose's createRemoteJWKSet for the verify side.
export interface JWTKeyContext {
  operation: 'sign' | 'verify'
  // verify: inspect the token's protected header (e.g. `kid`, `alg`) to select the key.
  protectedHeader?: JWSHeaderParameters
  // sign: select the key from the outgoing claims (e.g. tenant).
  payload?: JWTPayload
}

export type JWTKeyResolver = (ctx: JWTKeyContext) => Uint8Array | KeyLike | Promise<Uint8Array | KeyLike>

export interface JWTServiceOptions {
  // Symmetric secret. Mutually exclusive with privateKey/publicKey.
  secret?: string | Uint8Array
  // Asymmetric key pair. privateKey signs, publicKey verifies.
  privateKey?: KeyLike | Uint8Array
  publicKey?: KeyLike | Uint8Array
  // Dynamic key selection, evaluated per sign/verify call. Overrides the static keys above when set.
  keyResolver?: JWTKeyResolver
  // JWS algorithm. Defaults to HS256 for a symmetric secret; required for an asymmetric key pair.
  algorithm?: string
  issuer?: string
  audience?: string | string[]
  subject?: string
  // Token lifetime. A number is seconds FROM NOW; a string is a duration ('15m', '1h', '7d').
  expiresIn?: string | number
  // Not-before. A number is seconds FROM NOW; a string is a duration.
  notBefore?: string | number
  // Verification clock skew tolerance, in seconds or a duration string.
  clockTolerance?: string | number
}
