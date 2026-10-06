# Security review map

Read before reviewing `http/security` with the `security-audit` or `sharp-edges` skill. Paths are relative to
`http/security/auth/` unless they start with a package name.

## Scope

- `http/security/**`: authentication schemes, the authentication gate (`../authentication_plugin.ts`) and
  authorization (`../authz/`).
- `http/cookie/**`: parsing, signing (`signer.ts`), the browser rules (`rules.ts`) and the `Set-Cookie` writer
  (`plugin.ts`) every scheme's cookies go through.
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

| Credential                | Issued                                                       | Verified                                        | Bound to                                                | Rotated / revoked                                                                                           |
| ------------------------- | ------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Session cookie            | `cookie/cookie.ts` `persist`                                 | `authenticate` → `#principalFromCookie`         | scheme (HKDF `info`), `exp`, `validatePrincipal`        | re-issued on remember-me restore and when an older `sessionSecret` opened it; `revoke` clears the cookie    |
| Remember-me               | `#issueRemember` → `newSeriesToken`                          | `readSeriesToken`, `tokenMatches`               | series, SHA-256 of the token, idle and absolute TTL     | `rotateSeriesToken` on every use; replay removes the series                                                 |
| JWT                       | `jwt/jwt_service.ts` `sign`                                  | `verify`                                        | pinned `alg`, issuer, audience, required `exp`          | none; lifetime only                                                                                         |
| Opaque token              | application                                                  | `OpaqueTokenStore.validate`                     | application                                             | application                                                                                                 |
| Refresh token             | `refresh/refresh_token_service.ts` `issue`                   | `refresh`                                       | series, single use (`graceSeconds: 0`)                  | `refresh` rotates; `revoke`, `revokeAllForSubject`                                                          |
| OAuth/OIDC state and PKCE | `internal/remote/handler.ts` `startSignIn`                   | `#processCallback`                              | sealed state cookie per flow, scheme, issuer, S256      | state cookie deleted in `finally`                                                                           |
| id_token                  | provider                                                     | `oidc/handler.ts` `jwtVerify`, nonce, `at_hash` | issuer, audience = client ID, asymmetric `alg` only     | not stored                                                                                                  |
| Remote session and ticket | `writeSession`                                               | `authenticate`                                  | sealed cookie, or 32-byte ticket key                    | previous ticket removed on re-login; re-sealed when an older `sessionSecret` opened it; `revoke`, `signOut` |
| Signed cookie             | `ctx.cookie(..., { signed })`, `http/cookie/plugin.ts` flush | `ctx.req.signedCookie` → `CookieSigner.unsign`  | HMAC over the value; the server's secrets or the call's | `secret([current, previous])` rotates; `renew` on the signer                                                |
| Basic                     | client                                                       | the `validate` option                           | application                                             | application                                                                                                 |

## Invariants a change must keep

- JWT: `sign` sets `alg` from the service and throws without `expiresIn`; `verify` pins `algorithms`, `issuer` and
  `audience`; HMAC keys are at least the hash size (`assertHMACKeyLength`).
- Session secrets, every entry of a rotation list included, are at least `MIN_COOKIE_SECRET_LENGTH` (32) characters.
  `unsealJWT` pins `typ`; sealing keys are HKDF-SHA256 per purpose and scheme (`internal/sealed_jwt.ts`).
- Sealed-cookie rotation: the first secret seals and any opens. `openJWT` tries the next secret only on
  `ERR_JWE_DECRYPTION_FAILED`, so an expired or wrong-purpose token stops at the key that opened it. A re-issue keeps
  the original `exp`, so an old secret can be dropped once the longest session has run out.
- Signed cookies (`http/cookie/`): every secret, configured or handed to a call, is at least 32 characters. A
  signature is checked for its exact length and canonical base64 before `crypto.subtle.verify`, which compares in
  constant time. A cookie a browser would drop — a broken `__Host-`/`__Secure-`/`__Http-` prefix, `SameSite=None` or
  `Partitioned` without `Secure` — is refused where it is set, deletions included. Error text never repeats a cookie
  value. `secure: 'auto'` follows `request.protocol`, so it trusts a proxy only under `trustProxy`.
- Authentication cookies take every attribute from their scheme and pin `signed: false`; the server's `parseOptions`
  never reach them. Start-up refuses a scheme's cookie a browser would drop, two schemes writing one cookie name, and
  a cookie-based scheme on a server whose cookies are off.
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
  `internal/remote/_sealed_cookie.prop.test.ts`, `internal/remote/pkce.prop.test.ts`, `http/base_path.prop.test.ts`,
  `http/cookie/signer.prop.test.ts`.
- Cookie unit tests: `http/cookie/{signer,rules,serialize,cookie}.test.ts`; rotation in
  `internal/sealed_jwt.test.ts`, `cookie/cookie.test.ts` and `oidc/handler_ticket_store.test.ts`.
- End-to-end: `test/e2e/{basic,cookie,cookie_remember,jwt,opaque,refresh,oauth2,oidc,multi_scheme,spa_bff,fallback,authz,authz_startup,config_auth}.e2e.ts`.
- A confirmed finding lands with a regression test next to the code it fixes.
