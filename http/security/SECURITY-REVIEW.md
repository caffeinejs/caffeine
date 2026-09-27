# Security review map

Read before reviewing `http/security` with the `security-audit` or `sharp-edges` skill. Paths are relative to
`http/security/auth/` unless they start with a package name.

## Scope

- `http/security/**`: authentication schemes, the authentication gate (`../authentication_plugin.ts`) and
  authorization (`../authz/`).
- Related boundaries: response privacy in `caching/http/cache_control.ts` (rules in
  [`caching/AGENTS.md`](../../caching/AGENTS.md)), error bodies in `http/error/plugin.ts`, `~/` resolution in
  `http/base_path.ts` (`resolveAppURL`), file serving in `static/`, uploads in `multipart/`.

## Left to the application by design

Report these only if the framework's own docs promise otherwise.

- CSRF protection. The cookie scheme defaults to `SameSite=lax`; `examples/04-spa-dashboard` installs
  `@fastify/csrf-protection`.
- Credential checks for opaque tokens (`OpaqueTokenStore.validate`) and Basic (the `validate` option).
- Store implementations: `SeriesTokenStore` (remember-me and refresh) must make `rotate` an atomic compare-and-swap;
  `OpaqueTokenStore`, ticket stores.
- Fastify `trustProxy`; the framework never reads `X-Forwarded-*`, `Forwarded`, `Origin` or `Referer`.
- Validating the cookie scheme's `returnUrl` in the application's login endpoint; `isSafeReturnPath` is exported for it.
- Multipart limits, body limits beyond the form parser's 1 MB, and logger redaction.

## Credentials

| Credential                | Issued                                     | Verified                                        | Bound to                                            | Rotated / revoked                                            |
| ------------------------- | ------------------------------------------ | ----------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| Session cookie            | `cookie/cookie.ts` `persist`               | `authenticate` → `#principalFromCookie`         | scheme (HKDF `info`), `exp`, `validatePrincipal`    | re-issued on remember-me restore; `revoke` clears the cookie |
| Remember-me               | `#issueRemember` → `newSeriesToken`        | `readSeriesToken`, `tokenMatches`               | series, SHA-256 of the token, idle and absolute TTL | `rotateSeriesToken` on every use; replay removes the series  |
| JWT                       | `jwt/jwt_service.ts` `sign`                | `verify`                                        | pinned `alg`, issuer, audience, required `exp`      | none; lifetime only                                          |
| Opaque token              | application                                | `OpaqueTokenStore.validate`                     | application                                         | application                                                  |
| Refresh token             | `refresh/refresh_token_service.ts` `issue` | `refresh`                                       | series, single use (`graceSeconds: 0`)              | `refresh` rotates; `revoke`, `revokeAllForSubject`           |
| OAuth/OIDC state and PKCE | `internal/remote/handler.ts` `startSignIn` | `#processCallback`                              | sealed state cookie per flow, scheme, issuer, S256  | state cookie deleted in `finally`                            |
| id_token                  | provider                                   | `oidc/handler.ts` `jwtVerify`, nonce, `at_hash` | issuer, audience = client ID, asymmetric `alg` only | not stored                                                   |
| Remote session and ticket | `writeSession`                             | `authenticate`                                  | sealed cookie, or 32-byte ticket key                | previous ticket removed on re-login; `revoke`, `signOut`     |
| Basic                     | client                                     | the `validate` option                           | application                                         | application                                                  |

## Invariants a change must keep

- JWT: `sign` sets `alg` from the service and throws without `expiresIn`; `verify` pins `algorithms`, `issuer` and
  `audience`; HMAC keys are at least the hash size (`assertHMACKeyLength`).
- Session secrets are at least `MIN_SESSION_SECRET_LENGTH` (32) characters. `unsealJWT` pins `typ`; sealing keys
  are HKDF-SHA256 per purpose and scheme (`internal/sealed_jwt.ts`).
- Secret comparisons use `timingSafeEqual` after a length check: `tokenMatches`, `assertAccessTokenHash`, the
  scrypt `ScryptPasswordHasher`.
- A replayed remember-me or refresh token outside the grace window removes its whole series.
- One sealed state cookie per flow, at most eight outstanding; the callback re-checks `scheme` and `issuer` and
  deletes the state cookie in `finally`.
- Every redirect target passes `isSafeReturnPath` or is a configured absolute URL.
- Authentication responses are `noStore`; a presented cookie that does not resolve fails `authenticate`, it is
  not treated as absent.
- Remote-auth errors return `publicMessage` only; diagnostics go through `redactPii` unless `showPii` is set.

## Tests

- Property tests: `oidc/options.prop.test.ts`, `oidc/_at_hash.prop.test.ts`,
  `internal/remote/_sealed_cookie.prop.test.ts`, `internal/remote/pkce.prop.test.ts`, `http/base_path.prop.test.ts`.
- End-to-end: `test/e2e/{basic,cookie,cookie_remember,jwt,opaque,refresh,oauth2,oidc,multi_scheme,spa_bff,fallback,authz,authz_startup,config_auth}.e2e.ts`.
- A confirmed finding lands with a regression test next to the code it fixes.
