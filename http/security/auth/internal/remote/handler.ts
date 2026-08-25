import { randomBytes } from 'node:crypto'
import type { Context } from '../../../../context.js'
import { Claim, Identity, Principal } from '../../../index.js'
import { AuthenticateResult, AuthenticationTicket } from '../../ticket.js'
import { BaseAuthenticationHandler } from '../../handler.js'
import { isSafeReturnPath } from './config.js'
import { redactPii } from './pii.js'
import { generateCodeChallenge, generateCodeVerifier } from './pkce.js'
import { decodeState, encodeState, STATE_TTL_SECONDS } from './state_store.js'
import type { RemoteAuthenticationState } from './state_store.js'
import {
  assertValidSession,
  claimsToSession,
  decodeSession,
  decodeTicketRef,
  encodeSession,
  encodeTicketRef,
} from './session_store.js'
import type { RemoteAuthenticationSession } from './session_store.js'
import type { RemoteAuthenticationTicket, RemoteAuthenticationTicketStore } from './ticket_store.js'
import { ErrOAuthCallback, ErrOAuthSession } from './errors.js'

/** Raw tokens from the token endpoint. */
export interface RemoteAuthenticationTokens {
  accessToken?: string
  refreshToken?: string
  tokenType?: string
  expiresIn?: number
  scope?: string
  /** Present only for OpenID Connect providers. */
  idToken?: string
}

/** The principal material a protocol produces from a token response. */
export interface RemoteAuthenticationIdentity {
  claims: Claim[]
  /** The stable per-user identifier the ticket store indexes by. Must be non-empty. */
  subject: string
  /**
   * Tokens to persist with the server-side ticket.
   *
   * Set only when the strategy is configured to keep them. Silently ignored without a ticket
   * store — which is why the option that produces them refuses to configure without one,
   * rather than quietly degrading to a session that cannot do what was asked of it.
   */
  tokens?: RemoteAuthenticationTokens
}

/**
 * How an unauthenticated request is challenged.
 *
 * The flow starts with a redirect to the provider, which only a browser navigation can follow: `fetch` and
 * `XMLHttpRequest` follow it themselves, land on a cross-origin provider that sends no CORS headers, and the
 * caller sees an opaque network error instead of "you are not signed in". So the default picks per request.
 *
 * - `auto` — redirect a navigation, answer 401 to anything else.
 * - `redirect` — always redirect, whatever the caller is.
 * - `status` — always 401. For an API with no browser surface at all.
 */
export type RemoteChallengeMode = 'auto' | 'redirect' | 'status'

/** The options every OAuth-family strategy shares. */
export interface RemoteAuthenticationOptions {
  clientID: string
  clientSecret: string
  callbackURL: string
  defaultRedirectPath: string
  scopes: string[]

  sessionSecret: string
  sessionCookieName: string
  sessionCookieTtlSeconds: number
  stateCookieName: string
  secureCookie: boolean

  roleClaimType: string
  httpTimeoutMs: number
  showPii: boolean
  challengeMode: RemoteChallengeMode

  ticketStore?: RemoteAuthenticationTicketStore
  onFail?: (ctx: Context, error: Error) => Promise<void> | void
  onChallenge?: (ctx: Context, authorizationURL: string) => Promise<void> | void
  onForbid?: (ctx: Context) => Promise<void> | void
  /** Adjusts the authorization URL before the redirect. Guarded parameters are re-asserted. */
  onRedirectToProvider?: (ctx: Context, url: URL) => Promise<void> | void
}

/**
 * The machinery shared by the OpenID Connect and plain OAuth 2.0 strategies.
 *
 * Everything here is protocol-independent: reading a session, minting and validating state,
 * the PKCE round trip, writing the session cookie or ticket, and signing out. What differs
 * between the two protocols is confined to the abstract members below, so the guarantees this
 * class enforces — fail-closed session reads, the strategy binding on state, an unguessable
 * ticket key — hold for every strategy rather than being reimplemented per protocol.
 */
export abstract class RemoteAuthenticationHandler<
  O extends RemoteAuthenticationOptions,
> extends BaseAuthenticationHandler<O> {
  protected readonly name: string
  readonly #callbackPath: string

  constructor(name: string, options: O) {
    super(options)
    this.name = name
    this.#callbackPath = new URL(options.callbackURL).pathname
  }

  /** The strategy name this handler was registered under. */
  get schemeName(): string {
    return this.name
  }

  get callbackPath(): string {
    return this.#callbackPath
  }

  /** Exposed so startup can reject two strategies writing the same cookie. */
  get sessionCookieName(): string {
    return this.options.sessionCookieName
  }

  get stateCookieName(): string {
    return this.options.stateCookieName
  }

  // ---------------------------------------------------------------- protocol seams

  /** The provider identity bound into state and re-checked on callback. */
  protected abstract resolveIssuer(): Promise<string>

  /** The authorization endpoint to redirect to. */
  protected abstract resolveAuthorizationEndpoint(): Promise<string>

  /** Parameters beyond the ones every provider needs. */
  protected abstract authorizationParams(
    args: { state: string, nonce: string, codeChallenge: string },
  ): Promise<Record<string, string>> | Record<string, string>

  /** Exchanges the code, then turns the response into claims. Protocol-specific throughout. */
  protected abstract exchangeAndBuildIdentity(
    ctx: Context,
    code: string,
    stored: RemoteAuthenticationState,
  ): Promise<RemoteAuthenticationIdentity>

  /** Whether this strategy sends PKCE, and with which method. */
  protected abstract resolvePKCEMethod(): Promise<'S256' | 'plain' | 'none'>

  /** Wraps a callback failure in the protocol's error type. Override to change the class only. */
  protected callbackError(message: string): Error {
    return new ErrOAuthCallback(message)
  }

  /** Wraps a session-read failure in the protocol's error type. */
  protected sessionError(message: string): Error {
    return new ErrOAuthSession(message)
  }

  /**
   * A callback failure, named by the strategy that raised it.
   *
   * The strategy name rather than the protocol name: with Google, Okta and GitHub all
   * configured, "OIDC" does not say which handler failed. Names are developer-authored
   * configuration, never user data, so they stay outside the redaction boundary.
   */
  protected callbackFailure(detail: string): Error {
    return this.callbackError(`Cannot process callback for "${this.name}": ${detail}`)
  }

  // ---------------------------------------------------------------- shared behaviour

  async authenticate(ctx: Context): Promise<AuthenticateResult> {
    const cookie = ctx.req.cookie(this.options.sessionCookieName)
    if (!cookie) {
      return AuthenticateResult.none()
    }

    let session: RemoteAuthenticationSession
    try {
      session = this.options.ticketStore
        ? await this.#retrieveTicket(cookie)
        : await decodeSession(cookie, this.options.sessionSecret, this.name)
    } catch (e) {
      // A cookie was presented and it did not resolve to a session — expired, tampered,
      // revoked, or a cookie of another purpose replayed as a session. That is a failure,
      // not an absent credential.
      const detail = redactPii('session cookie', (e as Error).message, this.options.showPii)
      const error = this.sessionError(`Cannot read session cookie for "${this.name}": ${detail}`)
      await this.options.onFail?.(ctx, error)
      return AuthenticateResult.fail(error)
    }

    // Unreachable once cookie names and derived keys are both namespaced by strategy — which
    // is the point. It is the backstop for a deployment that sets the same cookie name on two
    // handlers explicitly. Not a failure: another strategy's session is simply not this
    // handler's credential to judge, and under a Forward default the right one still runs.
    if (session.scheme !== this.name) {
      return AuthenticateResult.none()
    }

    const claims = session.claims.map(c => new Claim(c.type, c.value, c.issuer))
    const identity = new Identity(session.scheme, true, claims, this.options.roleClaimType)
    const principal = new Principal(true, identity)

    return AuthenticateResult.success(new AuthenticationTicket(principal, session.scheme))
  }

  /**
   * Resolves a reference cookie against the ticket store.
   *
   * Every path out of here other than a live ticket throws, so authentication fails closed:
   * a store that is down or throwing must never be the reason someone is let in.
   */
  async #retrieveTicket(cookie: string): Promise<RemoteAuthenticationSession> {
    const key = await decodeTicketRef(cookie, this.options.sessionSecret, this.name)

    let ticket: Awaited<ReturnType<RemoteAuthenticationTicketStore['retrieve']>>
    try {
      ticket = await this.options.ticketStore!.retrieve(key)
    } catch (e) {
      throw new Error(`ticket store is unavailable: ${(e as Error).message}`, { cause: e })
    }

    if (!ticket) {
      throw new Error('session was revoked or has expired')
    }

    // The store is deployment-supplied; a malformed return must fail closed here, inside the
    // caller's try, rather than surface as a TypeError on the later claims.map.
    assertValidSession(ticket.session)
    return ticket.session
  }

  override async challenge(ctx: Context): Promise<void> {
    const [issuer, endpoint, pkceMethod] = await Promise.all([
      this.resolveIssuer(),
      this.resolveAuthorizationEndpoint(),
      this.resolvePKCEMethod(),
    ])

    const codeVerifier = generateCodeVerifier()
    const codeChallenge = pkceMethod === 'S256' ? generateCodeChallenge(codeVerifier) : codeVerifier

    const state = randomBytes(16).toString('base64url')
    const nonce = randomBytes(16).toString('base64url')

    const stateCookie = await encodeState(
      {
        state,
        nonce,
        codeVerifier,
        pkceMethod: pkceMethod === 'none' ? 'S256' : pkceMethod,
        returnTo: ctx.req.url,
        scheme: this.name,
        issuer,
      },
      this.options.sessionSecret,
      this.name,
    )

    ctx.cookie(this.options.stateCookieName, stateCookie, this.cookieOpts(STATE_TTL_SECONDS))

    const authURL = new URL(endpoint)
    authURL.searchParams.set('client_id', this.options.clientID)
    authURL.searchParams.set('redirect_uri', this.options.callbackURL)
    authURL.searchParams.set('response_type', 'code')
    authURL.searchParams.set('scope', this.options.scopes.join(' '))
    authURL.searchParams.set('state', state)
    if (pkceMethod !== 'none') {
      authURL.searchParams.set('code_challenge', codeChallenge)
      authURL.searchParams.set('code_challenge_method', pkceMethod)
    }
    const guarded = new Set(this.guardedAuthorizationParams())
    for (const [key, value] of Object.entries(await this.authorizationParams({ state, nonce, codeChallenge }))) {
      // A guarded parameter the base has already set is not the subclass's to replace, and by
      // extension not a caller's either — provider-specific extras reach here as ordinary
      // entries, and one named `redirect_uri` would otherwise send the code somewhere else.
      // Guarded parameters the base does not set, such as the OIDC nonce, still pass through.
      if (guarded.has(key) && authURL.searchParams.has(key)) {
        continue
      }
      authURL.searchParams.set(key, value)
    }

    await this.#applyRedirectHook(ctx, authURL)

    // The hook runs only after state, PKCE and the state cookie are in place, so overriding
    // the response can never bypass the flow's security machinery.
    const authorizationURL = authURL.toString()
    if (this.options.onChallenge) {
      return this.options.onChallenge(ctx, authorizationURL)
    }

    if (this.#redirects(ctx)) {
      ctx.redirect(authorizationURL, 302)
      return
    }

    // The state cookie was set above and is on this response too, so a caller that sends the browser to the
    // URL completes the same flow — nothing is discarded by answering with a status instead of a redirect.
    //
    // No `WWW-Authenticate`: the credential is a cookie, not an HTTP authentication scheme, so there is no
    // registered token to name and inventing one would mislead a client that parses it. `location` on a 401
    // is a hint — browsers follow it only on a 3xx — which is exactly the intent.
    ctx.status(401).header('location', authorizationURL)
  }

  /**
   * Whether this request should be redirected into the provider rather than answered 401.
   *
   * `sec-fetch-mode`/`sec-fetch-dest` are the direct answer and every current browser sends them; the `accept`
   * fallback covers the ones that do not, and anything that asks for HTML wants a page. A caller sending
   * neither — `fetch` with no options, `curl`, a client library — gets the 401.
   */
  #redirects(ctx: Context): boolean {
    const mode = this.options.challengeMode
    if (mode !== 'auto') {
      return mode === 'redirect'
    }

    return ctx.req.header('sec-fetch-mode') === 'navigate'
      || ctx.req.header('sec-fetch-dest') === 'document'
      || (ctx.req.header('accept')?.includes('text/html') ?? false)
  }

  /**
   * Parameters the redirect hook may read but not change.
   *
   * Everything else is fair game — adjusting `prompt` or `login_hint` per request is the
   * hook's whole purpose. These are the ones whose alteration would silently weaken the flow:
   * a different `redirect_uri` sends the code elsewhere, a missing `code_challenge` disables
   * PKCE, and a replaced `state` unbinds the callback from this browser.
   */
  protected guardedAuthorizationParams(): string[] {
    return [
      'client_id',
      'redirect_uri',
      'response_type',
      'scope',
      'state',
      'code_challenge',
      'code_challenge_method',
    ]
  }

  /**
   * Runs the redirect hook against a throwaway copy, then adopts only the changes it is allowed
   * to make: additions and edits to non-guarded query parameters.
   *
   * The hook is handed a clone, never the real authorization URL. That makes the two things it
   * must not touch structurally unreachable rather than merely restored afterwards:
   *
   * - The endpoint. A hook holding the live URL can do `url.host = 'evil.example'`, and a
   *   restore-the-parameters approach then re-applies `client_id`, `state` and `code_challenge`
   *   onto the attacker's origin. Since the hook only ever sees the clone, `origin` and
   *   `pathname` here are never in its reach — provider-specific endpoints belong in a typed
   *   option, not in a mutable URL.
   * - The guarded parameters. Their values are taken from this handler after the hook runs, so
   *   a stray `delete('code_challenge')` or a replaced `redirect_uri` cannot survive.
   */
  async #applyRedirectHook(ctx: Context, url: URL): Promise<void> {
    if (!this.options.onRedirectToProvider) {
      return
    }

    const draft = new URL(url.toString())
    await this.options.onRedirectToProvider(ctx, draft)

    const guarded = new Set(this.guardedAuthorizationParams())
    const merged = new URLSearchParams()

    // The hook's take on the non-guarded parameters — prompt, login_hint, anything it added.
    for (const [key, value] of draft.searchParams) {
      if (!guarded.has(key)) {
        merged.set(key, value)
      }
    }

    // The guarded parameters, always this handler's own values, never the hook's. A guarded
    // parameter the handler never set stays unset — the hook cannot introduce one either,
    // since the callback would then check against something the state cookie does not know.
    for (const key of guarded) {
      const ours = url.searchParams.get(key)
      if (ours !== null) {
        merged.set(key, ours)
      }
    }

    url.search = merged.toString()
  }

  override async forbid(ctx: Context): Promise<void> {
    if (this.options.onForbid) {
      return this.options.onForbid(ctx)
    }

    ctx.status(403)
  }

  /**
   * Ends the sign-in for this strategy: drops the server-side ticket, if any, and clears the
   * cookie.
   *
   * How complete that is depends on whether a `ticketStore` is configured. With one, the
   * session stops working everywhere immediately, and `RemoteAuthenticationTicketStore.removeBySubject` ends
   * every session the user holds. Without one the sealed cookie *is* the session: this clears
   * the responding browser's copy and nothing more, so any other copy — a synced profile, a
   * captured header — stays valid until `sessionCookieTtlSeconds` elapses.
   *
   * The cookie is cleared unconditionally: a store that throws must not leave the browser
   * holding something that still looks like a session. The store failure is propagated, since
   * a sign-out that did not actually revoke must not report success.
   */
  override async revoke(ctx: Context): Promise<void> {
    try {
      const key = await this.ticketKey(ctx)
      if (key) {
        await this.options.ticketStore!.remove(key)
      }
    } finally {
      ctx.deleteCookie(this.options.sessionCookieName, this.cookieOpts())
    }
  }

  /**
   * The stored ticket key the request is carrying, or undefined if there is nothing to act on.
   *
   * An unreadable cookie is not an error here: there is no ticket to remove either way. A
   * store that throws, on the other hand, is propagated — a sign-out that did not actually
   * revoke must not report success.
   */
  protected async ticketKey(ctx: Context): Promise<string | undefined> {
    const cookie = ctx.req.cookie(this.options.sessionCookieName)
    if (!this.options.ticketStore || !cookie) {
      return undefined
    }

    try {
      return await decodeTicketRef(cookie, this.options.sessionSecret, this.name)
    } catch {
      return undefined
    }
  }

  /**
   * The stored ticket the request is carrying, or undefined.
   *
   * Unlike `authenticate()`, a store failure is not fatal here: callers use this to read
   * material *about* a session they have already been granted — the saved tokens for a logout
   * redirect — rather than to decide whether to grant one.
   */
  protected async currentTicket(ctx: Context): Promise<RemoteAuthenticationTicket | undefined> {
    const key = await this.ticketKey(ctx)
    if (!key) {
      return undefined
    }

    try {
      return await this.options.ticketStore!.retrieve(key)
    } catch {
      return undefined
    }
  }

  async processCallback(ctx: Context): Promise<void> {
    try {
      await this.#processCallback(ctx)
    } catch (e) {
      await this.options.onFail?.(ctx, e as Error)
      throw e
    }
  }

  async #processCallback(ctx: Context): Promise<void> {
    const code = ctx.req.query('code')
    const stateParam = ctx.req.query('state')

    // RFC 6749 §4.1.2.1: a denied or failed authorization comes back as an error redirect,
    // not an absent code. Report what the provider actually said.
    const error = ctx.req.query('error')
    if (error) {
      // error_description is provider-authored free text of unconstrained content — it can
      // name the user or the reason they were denied — so it is treated as PII.
      const description = ctx.req.query('error_description')
      const detail = description === undefined
        ? ''
        : `: ${redactPii('error_description', description, this.options.showPii)}`
      throw this.callbackFailure(`provider returned "${error}"${detail}`)
    }

    if (!code) {
      throw this.callbackFailure('missing code parameter')
    }

    const stateCookieName = this.options.stateCookieName
    const stateCookie = ctx.req.cookie(stateCookieName)
    if (!stateCookie) {
      throw this.callbackFailure('missing state cookie')
    }

    let stored: RemoteAuthenticationState
    try {
      stored = await decodeState(stateCookie, this.options.sessionSecret, this.name)
    } catch {
      throw this.callbackFailure('invalid or expired state cookie')
    }

    if (stateParam !== stored.state) {
      throw this.callbackFailure('state mismatch')
    }

    // The state is sealed under this strategy's key, so a mismatch here means the payload was
    // minted for a different handler. Checked in the payload as well as the key so the binding
    // survives any future change to key derivation.
    if (stored.scheme !== this.name) {
      throw this.callbackFailure('state was issued for another strategy')
    }

    ctx.deleteCookie(stateCookieName, this.cookieOpts())

    // The provider the state was minted against must still be the one we would use now. A
    // mismatch means the strategy was reconfigured — or two configurations are running — between
    // the challenge and this callback, and the authorization code must not be exchanged against
    // a provider the user did not authenticate with. OIDC binds this to the discovery issuer,
    // OAuth2 to the authorization endpoint origin; the check lives here so both get it and a
    // future protocol inherits it rather than re-deriving it.
    const issuer = await this.resolveIssuer()
    if (stored.issuer !== issuer) {
      throw this.callbackFailure('state was issued against a different issuer')
    }

    const identity = await this.exchangeAndBuildIdentity(ctx, code, stored)

    // Mirrors the OIDC `sub` requirement: without a stable identifier the ticket store cannot
    // revoke by user, so "sign out everywhere" and erasure both silently stop working.
    if (!identity.subject) {
      throw this.callbackFailure('the provider returned no stable user identifier')
    }

    await this.writeSession(ctx, identity)

    const fallback = this.options.defaultRedirectPath
    const returnTo = stored.returnTo
      && stored.returnTo !== this.#callbackPath
      && isSafeReturnPath(stored.returnTo)
      ? stored.returnTo
      : fallback

    ctx.redirect(returnTo, 302)
  }

  /**
   * Persists the principal: a server-side ticket when a store is configured, otherwise a
   * self-contained sealed cookie.
   */
  protected async writeSession(ctx: Context, identity: RemoteAuthenticationIdentity): Promise<void> {
    const ttl = this.options.sessionCookieTtlSeconds
    const session = claimsToSession(identity.claims, this.name)
    const store = this.options.ticketStore

    let cookieValue: string
    if (store) {
      // Signing in again while already signed in would otherwise orphan the previous ticket
      // for the rest of its TTL, leaving a revocable session nobody holds a cookie for.
      const previous = await this.ticketKey(ctx)
      if (previous) {
        await store.remove(previous)
      }

      // The handler owns key generation: the key is the bearer credential for the whole
      // session, so its entropy cannot be left to the store implementation.
      const key = randomBytes(32).toString('base64url')
      await store.store(key, { session, subject: identity.subject, tokens: identity.tokens }, ttl)
      cookieValue = await encodeTicketRef(key, this.options.sessionSecret, this.name, ttl)
    } else {
      cookieValue = await encodeSession(session, this.options.sessionSecret, this.name, ttl)
    }

    ctx.cookie(this.options.sessionCookieName, cookieValue, this.cookieOpts(ttl))
  }

  protected cookieOpts(maxAge?: number): Record<string, unknown> {
    return {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: this.options.secureCookie,
      ...(maxAge !== undefined ? { maxAge } : {}),
    }
  }
}
