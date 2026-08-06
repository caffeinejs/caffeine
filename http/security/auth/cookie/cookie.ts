import type { Provider } from '@caffeinejs/di'
import type { Context } from '../../../context.js'
import { Claim, Identity, Principal } from '../../index.js'
import { BaseAuthenticationHandler } from '../handler.js'
import { AuthenticateResult, AuthenticationTicket } from '../ticket.js'
import { buildCredentialPrincipal, type UserProvider } from '../credentials/index.js'
import type { CookieAuthenticationOptions } from './cookie_options.js'
import { sealSession, unsealSession } from './_session_cookie.js'
import type { RememberMeTokenStore } from './remember_me_token_store.js'
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
 * Stateful cookie session scheme (ASP.NET Cookie authentication).
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
        return AuthenticateResult.success(new AuthenticationTicket(await this.#principalFromCookie(raw), this.#name))
      } catch {
        // Expired or tampered session cookie: fall through to the remember-me path (if any).
      }
    }

    if (this.#durable()) {
      return this.#refreshFromRemember(ctx)
    }

    return AuthenticateResult.none()
  }

  override async persist(ctx: Context, ticket: AuthenticationTicket): Promise<void> {
    const rememberMe = Boolean((ticket.properties as { rememberMe?: boolean } | undefined)?.rememberMe)

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

  override async challenge(ctx: Context): Promise<void> {
    if (this.options.onChallenge) {
      return this.options.onChallenge(ctx)
    }

    if (this.options.loginPath !== undefined) {
      ctx.status(302).header('location', this.options.loginPath)
      return
    }

    ctx.status(401)
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
    const subject = String(principal.findFirst('sub')?.value ?? '')
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

    if (!tokenMatches(parsed.token, record.tokenHash)) {
      // Series is known but the token is wrong: a stale or stolen token was replayed. Invalidate the
      // series so the legitimate holder is forced to re-authenticate too.
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

    // Rotate the token (single-use), extend expiry, and re-establish a fresh session cookie.
    const rotated = newToken()
    await store.updateToken(parsed.series, hashToken(rotated), this.#now() + this.options.rememberMeMaxAge!)
    this.#setRememberCookie(ctx, parsed.series, rotated)
    await this.#writeSessionCookie(ctx, principal, this.options.maxAge!, false)

    return AuthenticateResult.success(new AuthenticationTicket(principal, this.#name))
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
