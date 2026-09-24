import { resolveAppURL } from '../../../../base_path.js'
import type { Context } from '../../../../context.js'
import { isNavigation } from '../../../../navigation.js'
import type { AuthenticationProperties } from '../../ticket.js'
import { ErrOAuthConfiguration } from './errors.js'

/** Secrets shorter than this leave the derived cookie keys brute-forceable. */
export const MIN_SESSION_SECRET_LENGTH = 32

/**
 * The deadline applied to every outbound provider call.
 *
 * Shared rather than repeated per call site: a request without one is held open for as long
 * as the provider likes, and a sign-in path that hangs holds a connection with it. Presets
 * making their own provider calls must use this too — the option that overrides it is not
 * reachable from every one of them.
 */
export const DEFAULT_HTTP_TIMEOUT_MS = 5000

/**
 * How an unauthenticated request is challenged by a scheme whose challenge is a redirect.
 *
 * A redirect to a login page or an identity provider is only followable by a browser navigation: `fetch`
 * and `XMLHttpRequest` follow it themselves, land somewhere that sends no CORS headers, and the caller
 * sees an opaque network error instead of "you are not signed in". So the default picks per request.
 *
 * - `auto` — redirect a navigation, answer 401 to anything else.
 * - `redirect` — always redirect, whatever the caller is.
 * - `status` — always 401. For an API with no browser surface at all.
 */
export type ChallengeMode = 'auto' | 'redirect' | 'status'

/** The request headers `shouldRedirectChallenge` reads. Keeps it independent of any particular Context. */
export interface ChallengeRequestHeaders {
  secFetchMode: string | undefined
  secFetchDest: string | undefined
  accept: string | undefined
}

/** Reads the headers {@link shouldRedirectChallenge} needs off a request context. */
export function challengeHeaders(ctx: { req: { header(key: string): string | undefined } }): ChallengeRequestHeaders {
  return {
    secFetchMode: ctx.req.header('sec-fetch-mode'),
    secFetchDest: ctx.req.header('sec-fetch-dest'),
    accept: ctx.req.header('accept'),
  }
}

/**
 * Whether a challenge should redirect rather than answer a status.
 *
 * The question is {@link isNavigation}'s; a request that says neither way is answered with a status, since a
 * redirect is only followable by a browser.
 */
export function shouldRedirectChallenge(mode: ChallengeMode, headers: ChallengeRequestHeaders): boolean {
  if (mode !== 'auto') {
    return mode === 'redirect'
  }

  return isNavigation(headers) ?? false
}

/**
 * Resolves the default for `secureCookie` from the callback URL.
 *
 * Production is secure by default while local `http://localhost` development still works.
 * Unparseable URLs fail closed.
 */
export function defaultSecureCookie(callbackURL: string): boolean {
  try {
    return new URL(callbackURL).protocol === 'https:'
  } catch {
    return true
  }
}

/**
 * Control characters that the WHATWG URL parser strips before resolving.
 *
 * They must be rejected outright: `"/\t/evil.com"` clears a naive prefix check — its second
 * character is neither `/` nor `\` — but the parser removes the tab and resolves it to
 * `//evil.com`, sending the browser off-origin. Tab, LF and CR are the stripped set; the
 * rest are rejected because a control character has no business in a redirect target.
 */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\x00-\x1F\x7F]/

/**
 * Rejects a post-login redirect target that could leave the origin.
 *
 * A leading `//` or `/\` is protocol-relative and would send the browser elsewhere, and a
 * control character can smuggle that same prefix past the check.
 */
export function isSafeReturnPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\') && !CONTROL_CHARACTERS.test(path)
}

/**
 * Where a challenge sends the browser back to once it has signed in, as the browser will request it: the caller's
 * `redirectURI`, with a `~/` resolved against the base path, or else the URL the challenge interrupted, base path
 * included. Not yet checked — the caller still owes it {@link isSafeReturnPath}.
 */
export function returnTargetOf(ctx: Context, properties: AuthenticationProperties | undefined): string {
  const requested = properties?.redirectURI
  if (requested === undefined) {
    return ctx.req.basePath + ctx.req.url
  }

  // A caller written in plain JavaScript may hand over anything. What is not a string is dropped: `''` fails the
  // check that follows, and names no destination on the callback either.
  return typeof requested === 'string' ? resolveAppURL(requested, ctx.req.basePath) : ''
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Every protocol endpoint must use TLS (OIDC Core §16.17; the same reasoning applies to plain
 * OAuth 2.0, where the code and access token are just as interceptable). Plain `http:` is
 * tolerated only for loopback development, where there is no network to intercept.
 */
export function assertSecureEndpoint(label: string, value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ErrOAuthConfiguration(`Cannot configure authentication: ${label} "${value}" is not a valid URL`)
  }

  if (url.protocol === 'https:') {
    return
  }

  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) {
    return
  }

  throw new ErrOAuthConfiguration(
    `Cannot configure authentication: ${label} "${value}" must use https (http is allowed only for loopback)`,
  )
}

/**
 * Reduces a strategy name to a cookie-name-safe token.
 *
 * Cookie names admit a limited character set, and the scheme is caller-supplied. Anything
 * outside `[A-Za-z0-9_-]` collapses to `_`; a name that leaves nothing behind is a
 * configuration error rather than a silently unnamespaced cookie.
 */
export function sanitizeSchemeName(scheme: string): string {
  const sanitized = scheme.replace(/[^A-Za-z0-9_-]/g, '_')
  if (sanitized.length === 0 || /^_+$/.test(sanitized)) {
    throw new ErrOAuthConfiguration(
      `Cannot configure authentication: strategy name "${scheme}" has no characters usable in a cookie name`,
    )
  }
  return sanitized
}

/**
 * Builds a cookie name namespaced by strategy.
 *
 * Always namespaced, not only when several strategies are registered: two handlers on default
 * names would otherwise overwrite each other's cookies, and a deployment that adds a second
 * provider later would break the first without touching its configuration. `__Host-` binds the
 * cookie to the exact origin with `Path=/` and no `Domain`, and is only legal on a Secure cookie.
 */
export function cookieName(kind: 'session' | 'state', scheme: string, secure: boolean, protocol: string): string {
  const prefix = secure ? `__Host-${protocol}` : `__${protocol}`
  return `${prefix}_${sanitizeSchemeName(scheme)}_${kind}`
}
