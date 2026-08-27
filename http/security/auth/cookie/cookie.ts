import type { Provider } from '@caffeinejs/di'
import type { Context } from '../../../context.js'
import { Claim, Identity, Principal } from '../../index.js'
import { BaseAuthenticationHandler } from '../handler.js'
import { AuthenticateResult, type AuthenticationProperties, AuthenticationTicket } from '../ticket.js'
import { challengeHeaders, isSafeReturnPath, shouldRedirectChallenge } from '../internal/remote/config.js'
import { buildCredentialPrincipal, type UserProvider } from '../credentials/index.js'
import type { CookieAuthenticationOptions } from './cookie_options.js'
import { sealSession, unsealSession } from './_session_cookie.js'
import type { RememberMeRecord, RememberMeTokenStore } from './remember_me_token_store.js'
import { formatRemember, hashToken, newSeries, newToken, parseRemember, tokenMatches } from './_remember.js'

interface SealedClaim {
  type: string
  value: unknown
  issuer: string
}

interface SessionPayload {
  scheme: string
  claims: SealedClaim[]
  roleClaimType: string
}

/**
 * Stateful cookie session scheme.
 *
 * `persist` is sign-in (seal the principal into an encrypted cookie), `revoke` is sign-out (clear it),
 * `authenticate` reads and unseals the cookie back into a principal. A login endpoint verifies
 * credentials with `CredentialsService` and then persists the session via `AuthenticationService`.
 * Requires the Fastify cookie plugin to be registered on the instance.
 *
 * With durable remember-me enabled (`rememberMe()` option + a bound `RememberMeTokenStore` and
 * `UserProvider`), a persistent series+token credential survives session-cookie expiry, rotates on
 * each use, detects stolen-token replay, and is revocable server-side.
 */
export class CookieAuthenticationHandler extends BaseAuthenticationHandler<CookieAuthenticationOptions> {
  readonly #name: string

  #rememberStore: Provider<RememberMeTokenStore> | undefined
  #userProvider: Provider<UserProvider> | undefined

  constructor(name: string, options: CookieAuthenticationOptions) {
    super(options)
    this.#name = name
  }

  /**
   * Injected at configure time (Forward/opaque-style) when durable remember-me is enabled, so the
   * container-bound store and user provider resolve lazily.
   */
  setRememberDeps(store: Provider<RememberMeTokenStore>, userProvider: Provider<UserProvider>): void {
    this.#rememberStore = store
    this.#userProvider = userProvider
  }

  #durable(): boolean {
    return this.options.rememberMe === true
      && this.#rememberStore !== undefined
      && this.#userProvider !== undefined
  }

  async authenticate(ctx: Context): Promise<AuthenticateResult> {
    const raw = ctx.req.cookie(this.options.cookieName!)
    if (raw) {
      try {
        const principal = await this.#validate(ctx, await this.#principalFromCookie(raw))
        if (principal) {
          return AuthenticateResult.success(new AuthenticationTicket(principal, this.#name))
        }

        // The hook rejected the session. Clear the cookie so the browser stops presenting a credential
        // that will never be accepted again, then fall through as if none had been sent.
        ctx.deleteCookie(this.options.cookieName!, { path: this.options.path })
        return AuthenticateResult.none()
      } catch {
        // Expired or tampered session cookie: fall through to the remember-me path (if any).
      }
    }

    if (this.#durable()) {
      return this.#refreshFromRemember(ctx)
    }

    return AuthenticateResult.none()
  }

  /**
   * Runs the configured `validatePrincipal` hook, if any.
   *
   * The sealed cookie is self-contained, so between issue and expiry the server has no say in whether it
   * still stands: a password change, a revoked account or a role removal does not reach a session already
   * in the wild, and the default lifetime is eight hours. This is the hook that lets a deployment answer
   * "is this session still good?" per request.
   *
   * Returning a principal replaces the one from the cookie, so the hook doubles as the refresh path for a
   * session whose claims have gone stale. Returning `null` rejects it.
   */
  async #validate(ctx: Context, principal: Principal): Promise<Principal | null> {
    const validate = this.options.validatePrincipal
    return validate === undefined ? principal : validate(ctx, principal)
  }

  override async persist(ctx: Context, ticket: AuthenticationTicket): Promise<void> {
    // `isPersistent` is the only name for this flag: keeping a `rememberMe` alias that the type
    // rejects but the runtime honours would mean the compiler and the behaviour disagree.
    const rememberMe = ticket.properties?.isPersistent === true

    if (this.#durable()) {
      // Session cookie is always short (dies with the browser); the remember cookie is the persistence.
      await this.#writeSessionCookie(ctx, ticket.principal, this.options.maxAge!, false)
      if (rememberMe) {
        await this.#issueRemember(ctx, ticket.principal)
      }
      return
    }

    // Stateless mode: rememberMe extends the session cookie itself into a persistent one.
    const ttl = rememberMe ? this.options.rememberMeMaxAge! : this.options.maxAge!
    await this.#writeSessionCookie(ctx, ticket.principal, ttl, rememberMe)
  }

  override async revoke(ctx: Context): Promise<void> {
    ctx.deleteCookie(this.options.cookieName!, { path: this.options.path })

    if (this.#durable()) {
      const rawRemember = ctx.req.cookie(this.options.rememberMeCookieName!)
      const parsed = rawRemember ? parseRemember(rawRemember) : null
      if (parsed) {
        await this.#rememberStore!.get().remove(parsed.series)
      }
      ctx.deleteCookie(this.options.rememberMeCookieName!, { path: this.options.path })
    }
  }

  /**
   * Sends a browser navigation to `loginPath`, and answers 401 to anything else.
   *
   * The negotiation matters here for the same reason it does on the OAuth strategies: a `fetch` follows a
   * 302 itself and resolves with the login page's HTML and a 200, so the caller cannot tell it was not
   * signed in — it just gets a document where it expected JSON. Fetch Metadata is the answer to that
   * question.
   */
  override async challenge(ctx: Context, properties?: AuthenticationProperties): Promise<void> {
    if (this.options.onChallenge) {
      return this.options.onChallenge(ctx)
    }

    if (this.options.loginPath === undefined) {
      ctx.status(401)
      return
    }

    const location = this.#loginLocation(ctx, properties)
    // `?? 'auto'` rather than `!`: the builder defaults it, but a directly-constructed handler leaves it
    // undefined and the two paths must not disagree about the default.
    if (shouldRedirectChallenge(this.options.challengeMode ?? 'auto', challengeHeaders(ctx))) {
      ctx.status(302).header('location', location)
      return
    }

    // Same reasoning as the OAuth strategies: `location` on a 401 is a hint a browser will not follow,
    // the body is what a cross-origin caller can actually read, and the header is exposed for the rest.
    ctx.status(401)
      .header('location', location)
      .header('access-control-expose-headers', 'location')
      .body({ error: 'authentication_required', loginURL: location })
  }

  /**
   * The login URL, carrying where to come back to.
   *
   * Without a return URL on the login path, signing in always lands on the application root and the page
   * the user was actually trying to reach is lost.
   *
   * The target is an explicit `redirectURI` when the caller supplied one, otherwise the URL the challenge
   * interrupted. Either way it is validated as a same-origin absolute path before being echoed back —
   * this value ends up in a `Location` after login, so an unchecked one is an open redirect, and the
   * caller-supplied case is not more trustworthy than the request-derived one.
   */
  #loginLocation(ctx: Context, properties?: AuthenticationProperties): string {
    // Fails closed to the bare login path: an off-origin or unparseable target is dropped rather than
    // echoed, since this value becomes a `Location` after sign-in.
    const target = properties?.redirectURI ?? ctx.req.url
    if (typeof target !== 'string' || !isSafeReturnPath(target)) {
      return this.options.loginPath!
    }

    const separator = this.options.loginPath!.includes('?') ? '&' : '?'
    return `${this.options.loginPath!}${separator}${this.options.returnURLParameter!}=${encodeURIComponent(target)}`
  }

  /**
   * Sends an authenticated-but-not-permitted caller to `accessDeniedPath`, or answers 403.
   *
   * Distinct from `challenge`: the caller proved who they are and it did not help, so pointing them back
   * at the login page invites a loop where signing in again changes nothing. Challenge and forbid are
   * therefore separate, with `accessDeniedPath` alongside `loginPath`.
   */
  override async forbid(ctx: Context, _properties?: AuthenticationProperties): Promise<void> {
    if (this.options.onForbid) {
      return this.options.onForbid(ctx)
    }

    if (this.options.accessDeniedPath !== undefined) {
      ctx.status(302).header('location', this.options.accessDeniedPath)
      return
    }

    ctx.status(403)
  }

  // --- session cookie -------------------------------------------------------

  async #principalFromCookie(raw: string): Promise<Principal> {
    const payload = await unsealSession<SessionPayload>(raw, this.options.sessionSecret, this.#name)
    const claims = payload.claims.map(c => new Claim(c.type, c.value, c.issuer))
    const identity = new Identity(payload.scheme, true, claims, payload.roleClaimType ?? this.options.roleClaimType)
    return new Principal(true, identity)
  }

  async #writeSessionCookie(ctx: Context, principal: Principal, ttl: number, persistent: boolean): Promise<void> {
    const payload: SessionPayload = {
      scheme: this.#name,
      claims: principal.claims().map(c => ({ type: c.type, value: c.value, issuer: c.issuer })),
      roleClaimType: this.options.roleClaimType!,
    }
    const sealed = await sealSession(
      payload as unknown as Record<string, unknown>, this.options.sessionSecret, this.#name, ttl)
    // Persistent cookie carries Max-Age; a session cookie omits it and dies with the browser. Either
    // way the sealed token's own `exp` is the hard cap, so a surviving cookie past expiry still fails.
    ctx.cookie(this.options.cookieName!, sealed, this.#cookieOpts(persistent ? ttl : undefined))
  }

  // --- durable remember-me --------------------------------------------------

  async #issueRemember(ctx: Context, principal: Principal): Promise<void> {
    // Coercing a missing `sub` to '' used to mint a record no `findById` could ever resolve, and whose
    // `removeBySubject('')` would either revoke nothing or revoke every other subjectless record. The
    // refresh-token grant already refuses the same principal for the same reason.
    const sub = principal.findFirst('sub')?.value
    if (typeof sub !== 'string' || sub.length === 0) {
      throw new Error('Cannot issue a remember-me credential: principal has no "sub" claim')
    }

    const subject = sub
    const series = newSeries()
    const token = newToken()
    const expiresAt = this.#now() + this.options.rememberMeMaxAge!
    await this.#rememberStore!.get().create({ series, subject, tokenHash: hashToken(token), expiresAt })
    this.#setRememberCookie(ctx, series, token)
  }

  async #refreshFromRemember(ctx: Context): Promise<AuthenticateResult> {
    const rawRemember = ctx.req.cookie(this.options.rememberMeCookieName!)
    if (!rawRemember) {
      return AuthenticateResult.none()
    }

    const parsed = parseRemember(rawRemember)
    if (!parsed) {
      this.#clearRememberCookie(ctx)
      return AuthenticateResult.none()
    }

    const store = this.#rememberStore!.get()
    const record = await store.findBySeries(parsed.series)
    if (!record) {
      this.#clearRememberCookie(ctx)
      return AuthenticateResult.none()
    }

    if (record.expiresAt <= this.#now()) {
      await store.remove(parsed.series)
      this.#clearRememberCookie(ctx)
      return AuthenticateResult.none()
    }

    // A token that is neither current nor within the rotation grace window is a replay: the series is
    // known, so someone holds a copy of a credential that was already spent. Invalidate the series and
    // force the legitimate holder to re-authenticate too — that is the point of the detection.
    const current = tokenMatches(parsed.token, record.tokenHash)
    const superseded = !current && this.#withinRotationGrace(parsed.token, record)
    if (!current && !superseded) {
      await store.remove(parsed.series)
      this.#clearRememberCookie(ctx)
      return AuthenticateResult.none()
    }

    const user = await this.#userProvider!.get().findById(record.subject)
    if (!user) {
      await store.remove(parsed.series)
      this.#clearRememberCookie(ctx)
      return AuthenticateResult.none()
    }

    const principal = buildCredentialPrincipal(user, { scheme: this.#name, roleClaimType: this.options.roleClaimType })

    // Rotate the token (single-use) and extend expiry — but only for the request holding the current
    // token. A superseded-but-in-grace token belongs to a request that raced the one which already
    // rotated; rotating again would spend a second token on its behalf and hand the browser a cookie
    // whose ordering against the winner's is undefined. Leave both the record and the cookie alone and
    // let the winner's response carry the new token.
    if (current) {
      const rotated = newToken()
      await store.updateToken(parsed.series, {
        tokenHash: hashToken(rotated),
        previousTokenHash: record.tokenHash,
        rotatedAt: this.#now(),
        expiresAt: this.#now() + this.options.rememberMeMaxAge!,
      })
      this.#setRememberCookie(ctx, parsed.series, rotated)
    }

    await this.#writeSessionCookie(ctx, principal, this.options.maxAge!, false)

    return AuthenticateResult.success(new AuthenticationTicket(principal, this.#name))
  }

  /**
   * Whether a superseded token is recent enough to be a raced in-flight request rather than a replay.
   *
   * Both halves must hold: the token has to match the hash this series most recently rotated away from,
   * and that rotation has to be inside the window. A store that does not persist the rotation fields
   * fails this check and falls through to theft detection — the conservative direction.
   */
  #withinRotationGrace(token: string, record: RememberMeRecord): boolean {
    const grace = this.options.rememberMeRotationGraceSeconds!

    // `0` is an off switch, not a zero-width window. `#now()` has second granularity, so a plain
    // `elapsed > grace` would still admit a replay landing in the same second as the rotation it
    // superseded — which is exactly the replay an operator choosing strict single-use is asking to catch.
    if (grace <= 0) {
      return false
    }

    if (record.previousTokenHash === undefined || record.rotatedAt === undefined) {
      return false
    }

    if (this.#now() - record.rotatedAt > grace) {
      return false
    }

    return tokenMatches(token, record.previousTokenHash)
  }

  #setRememberCookie(ctx: Context, series: string, token: string): void {
    ctx.cookie(this.options.rememberMeCookieName!, formatRemember(series, token),
      this.#cookieOpts(this.options.rememberMeMaxAge))
  }

  #clearRememberCookie(ctx: Context): void {
    ctx.deleteCookie(this.options.rememberMeCookieName!, { path: this.options.path })
  }

  #now(): number {
    return Math.floor(Date.now() / 1000)
  }

  #cookieOpts(maxAge?: number): Record<string, unknown> {
    return {
      httpOnly: true,
      secure: this.options.secure,
      sameSite: this.options.sameSite,
      path: this.options.path,
      ...(maxAge !== undefined ? { maxAge } : {}),
    }
  }
}
