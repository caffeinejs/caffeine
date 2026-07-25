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
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\x00-\x1F\x7F]/

/**
 * Rejects a post-login redirect target that could leave the origin.
 *
 * A leading `//` or `/\` is protocol-relative and would send the browser elsewhere, and a
 * control character can smuggle that same prefix past the check.
 */
export function isSafeReturnPath(path: string): boolean {
  return path.startsWith('/')
    && !path.startsWith('//')
    && !path.startsWith('/\\')
    && !CONTROL_CHARACTERS.test(path)
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
    throw new ErrOAuthConfiguration(
      `Cannot configure authentication: ${label} "${value}" is not a valid URL`,
    )
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
export function cookieName(
  kind: 'session' | 'state',
  scheme: string,
  secure: boolean,
  protocol: string,
): string {
  const prefix = secure ? `__Host-${protocol}` : `__${protocol}`
  return `${prefix}_${sanitizeSchemeName(scheme)}_${kind}`
}
