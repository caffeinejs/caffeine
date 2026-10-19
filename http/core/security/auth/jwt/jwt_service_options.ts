import type { Duration } from '@caffeinejs/std/duration'
import type { JWSHeaderParameters, JWTPayload, CryptoKey } from 'jose'

// Chooses a key per operation — enables rotation, JWKS, or per-tenant keys. A resolver may delegate to
// jose's createRemoteJWKSet for the verify side.
export interface JWTKeyContext {
  operation: 'sign' | 'verify'
  // verify: inspect the token's protected header (e.g. `kid`, `alg`) to select the key.
  protectedHeader?: JWSHeaderParameters
  // sign: select the key from the outgoing claims (e.g. tenant).
  payload?: JWTPayload
}

export type JWTKeyResolver = (ctx: JWTKeyContext) => Uint8Array | CryptoKey | Promise<Uint8Array | CryptoKey>

export interface JWTServiceOptions {
  // Symmetric secret. Mutually exclusive with privateKey/publicKey.
  secret?: string | Uint8Array
  // Asymmetric key pair. privateKey signs, publicKey verifies.
  privateKey?: CryptoKey | Uint8Array
  publicKey?: CryptoKey | Uint8Array
  // Dynamic key selection, evaluated per sign/verify call. Overrides the static keys above when set.
  keyResolver?: JWTKeyResolver
  // JWS algorithm. Defaults to HS256 for a symmetric secret; required for an asymmetric key pair.
  algorithm?: string
  issuer?: string
  audience?: string | string[]
  subject?: string
  // Token lifetime, from the moment a token is signed.
  expiresIn?: Duration
  // How long after it is signed a token starts to be accepted. Negative backdates it.
  notBefore?: Duration
  // Verification clock skew tolerance, in whole seconds.
  clockTolerance?: Duration
}
