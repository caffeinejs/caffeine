import type { Provider } from '@caffeinejs/di'

import type { Context } from '../../../context.js'
import { Claim, Identity, Principal } from '../../index.js'
import { buildCredentialPrincipal, type UserProvider } from '../credentials/index.js'
import { BaseAuthenticationHandler } from '../handler.js'
import { noStore } from '../internal/no_store.js'
import { challengeHeaders, isSafeReturnPath, shouldRedirectChallenge } from '../internal/remote/config.js'
import {
  newSeriesToken,
  parseToken,
  readSeriesToken,
  rotateSeriesToken,
  type SeriesTokenPolicy,
} from '../internal/series_token.js'
import { AuthenticateResult, type AuthenticationProperties, AuthenticationTicket } from '../ticket.js'
import { sealSession, unsealSession } from './_session_cookie.js'
import type { CookieAuthenticationOptions } from './cookie_options.js'
import type { RememberMeTokenStore } from './remember_me_token_store.js'

/**
 * The claim a principal carries when the session was restored from a remember-me credential instead of a
 * sign-in. A route that must not accept that — a change of password, a payment — asks for its absence.
 */
export const REMEMBERED_CLAIM = 'remembered'

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
    return this.options.rememberMe === true && this.#rememberStore !== undefined && this.#userProvider !== undefined
  }

  async authenticate(ctx: Context): Promise<AuthenticateResult> {
    const raw = ctx.req.cookie(this.options.cookieName!)
    let unreadable: Error | undefined

    if (raw) {
      let fromCookie: Principal | undefined

      // Only the unsealing is guarded. `validatePrincipal` runs outside it: when the application cannot tell
      // whether a session still stands — its store is down — that is an error to surface, not a reason to treat
      // a good cookie as a forged one and quietly sign the user out.
      try {
        fromCookie = await this.#principalFromCookie(raw)
      } catch (e) {
        unreadable = e as Error
      }

      if (fromCookie !== undefined) {
        const principal = await this.#validate(ctx, fromCookie)
        if (principal) {
          return AuthenticateResult.success(new AuthenticationTicket(principal, this.#name))
        }

        // The hook rejected the session. Clear the cookie so the browser stops presenting a credential
        // that will never be accepted again, then go on as if none had been sent.
        this.#clearSessionCookie(ctx)
        return AuthenticateResult.none()
      }

      // Expired, tampered with, or sealed under another secret: it will never be accepted, so it goes too.
      this.#clearSessionCookie(ctx)
      await this.options.onFail?.(ctx, unreadable!)
    }

    if (this.#durable()) {
      return this.#refreshFromRemember(ctx)
    }

    return unreadable === undefined ? AuthenticateResult.none() : AuthenticateResult.fail(unreadable)
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
    this.#clearSessionCookie(ctx)

    if (this.#durable()) {
      const rawRemember = ctx.req.cookie(this.options.rememberMeCookieName!)
      const parsed = rawRemember ? parseToken(rawRemember) : null
      if (parsed) {
        await this.#rememberStore!.get().remove(parsed.series)
      }
      this.#clearRememberCookie(ctx)
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
    noStore(ctx)

    // `?? 'auto'` rather than `!`: the builder defaults it, but a directly-constructed handler leaves it
    // undefined and the two paths must not disagree about the default.
    if (shouldRedirectChallenge(this.options.challengeMode ?? 'auto', challengeHeaders(ctx))) {
      ctx.status(302).header('location', location)
      return
    }

    // Same reasoning as the OAuth strategies: `location` on a 401 is a hint a browser will not follow,
    // the body is what a cross-origin caller can actually read, and the header is exposed for the rest.
    ctx
      .status(401)
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
      payload as unknown as Record<string, unknown>,
      this.options.sessionSecret,
      this.#name,
      ttl,
    )
    // Persistent cookie carries Max-Age; a session cookie omits it and dies with the browser. Either
    // way the sealed token's own `exp` is the hard cap, so a surviving cookie past expiry still fails.
    ctx.cookie(this.options.cookieName!, sealed, this.#cookieOpts(persistent ? ttl : undefined))
    noStore(ctx)
  }

  // --- durable remember-me --------------------------------------------------

  async #issueRemember(ctx: Context, principal: Principal): Promise<void> {
    // Coercing a missing `sub` to '' would mint a record no `findById` could ever resolve, and whose
    // `removeBySubject('')` would either revoke nothing or revoke every other subjectless record.
    const sub = principal.findFirst('sub')?.value
    if (typeof sub !== 'string' || sub.length === 0) {
      throw new Error('Cannot issue a remember-me credential: principal has no "sub" claim')
    }

    const { record, token } = newSeriesToken(sub, this.#rememberPolicy())
    await this.#rememberStore!.get().create(record)
    this.#setRememberCookie(ctx, token)
  }

  /**
   * Restores a session from the remember-me credential: reloads the user, and spends the token.
   *
   * A request that lost the rotation to a sibling presenting the same token — a browser sends a page's requests in
   * parallel, each with the cookie as it stood when the batch began — is let through inside the grace window
   * without a token of its own; the sibling's response carries the new one. Outside the window the same token was
   * spent twice, which is what a stolen copy looks like: the series is revoked and everyone signs in again.
   */
  async #refreshFromRemember(ctx: Context): Promise<AuthenticateResult> {
    const presented = ctx.req.cookie(this.options.rememberMeCookieName!)
    if (!presented) {
      return AuthenticateResult.none()
    }

    const store = this.#rememberStore!.get()
    const policy = this.#rememberPolicy()

    const reading = await readSeriesToken(store, presented, policy)
    if (reading.status === 'rejected') {
      return this.#rememberRefused(ctx, reading.reason)
    }

    const user = await this.#userProvider!.get().findById(reading.record.subject)
    if (!user) {
      await store.remove(reading.record.series)
      return this.#rememberRefused(ctx, 'unknown')
    }

    const [identity] = buildCredentialPrincipal(user, {
      scheme: this.#name,
      roleClaimType: this.options.roleClaimType,
    }).identities
    const remembered = new Principal(true, identity.withClaims(new Claim(REMEMBERED_CLAIM, true, '')))

    // The same say the application has over a session cookie: a user it no longer accepts is not remembered back in.
    const principal = await this.#validate(ctx, remembered)
    if (!principal) {
      await store.remove(reading.record.series)
      return this.#rememberRefused(ctx, 'unknown')
    }

    if (reading.status === 'current') {
      const rotated = await rotateSeriesToken(store, presented, reading.record, policy)
      if (rotated.status === 'rejected') {
        return this.#rememberRefused(ctx, rotated.reason)
      }

      if (rotated.status === 'rotated') {
        this.#setRememberCookie(ctx, rotated.token)
      }
    }

    await this.#writeSessionCookie(ctx, principal, this.options.maxAge!, false)

    return AuthenticateResult.success(new AuthenticationTicket(principal, this.#name))
  }

  async #rememberRefused(ctx: Context, reason: string): Promise<AuthenticateResult> {
    this.#clearRememberCookie(ctx)

    const error = new Error(`Remember-me credential refused: ${reason}`)
    await this.options.onFail?.(ctx, error)

    return AuthenticateResult.fail(error)
  }

  #rememberPolicy(): SeriesTokenPolicy {
    return {
      idleSeconds: this.options.rememberMeMaxAge!,
      absoluteSeconds: this.options.rememberMeAbsoluteMaxAge,
      graceSeconds: this.options.rememberMeRotationGraceSeconds!,
    }
  }

  #setRememberCookie(ctx: Context, token: string): void {
    ctx.cookie(this.options.rememberMeCookieName!, token, this.#cookieOpts(this.options.rememberMeMaxAge))
    noStore(ctx)
  }

  // A cookie is cleared with the attributes it was set with. A browser refuses a `__Host-` or `__Secure-` cookie
  // that arrives without `Secure` — the clearing one included, so signing out would leave it in place.
  #clearSessionCookie(ctx: Context): void {
    ctx.deleteCookie(this.options.cookieName!, this.#cookieOpts())
    noStore(ctx)
  }

  #clearRememberCookie(ctx: Context): void {
    ctx.deleteCookie(this.options.rememberMeCookieName!, this.#cookieOpts())
    noStore(ctx)
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
