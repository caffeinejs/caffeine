/**
 * Registered JWT/OIDC claims excluded from the default identity mapping.
 *
 * They describe the token rather than the user, and leaking them into the principal risks colliding with
 * the application claim types that policies and roles are written against — a token whose `aud` happens
 * to match a claim a policy checks should not satisfy it.
 *
 * Shared by the JWT and OpenID Connect handlers so the two agree. They did not: OIDC stripped these while
 * the JWT scheme emitted `iss`/`exp`/`aud`/`iat`/`nbf` as ordinary claims, so the same token produced
 * different principals depending on which scheme read it.
 *
 * `sub` is deliberately absent — it identifies the user, every policy that asks "who is this" reads it,
 * and both handlers depend on it reaching the principal.
 */
export const REGISTERED_CLAIMS: ReadonlySet<string> = new Set([
  'iss',
  'aud',
  'exp',
  'iat',
  'nbf',
  'jti',
  'nonce',
  'azp',
  'at_hash',
  'c_hash',
  'sid',
])
