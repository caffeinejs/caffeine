import type { CookieSameSite } from './options.js'

/** The attributes the rules read, as they will be written: `secure` already decided, not `'auto'`. */
export interface CookieAttributes {
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: boolean | CookieSameSite
  partitioned?: boolean
}

// cookie@2's own rule: printable US-ASCII but ";" and "=".
const NAME = /^[!-:<>-~]+$/

// RFC 6265bis §5.6: a user agent ignores an attribute whose value is longer.
const MAX_ATTRIBUTE_OCTETS = 1024

const encoder = new TextEncoder()

/** Whether `name` is one a `Set-Cookie` header can carry. */
export function isCookieName(name: string): boolean {
  return NAME.test(name)
}

/**
 * Why a browser would drop or misread a cookie with this name and these attributes, or `undefined` when none would.
 *
 * Covers the name, the prefixes (`__Secure-`, `__Host-`, and the `__Http-` and `__Host-Http-` that Chromium enforces),
 * `SameSite=None` and `Partitioned` without `Secure`, and attribute lengths. Prefixes are matched case-insensitively,
 * as user agents match them (RFC 6265bis §5.4).
 */
export function cookieRuleViolation(name: string, attributes: CookieAttributes): string | undefined {
  if (name === '') {
    return 'a cookie needs a name'
  }

  if (!isCookieName(name)) {
    return 'its name may hold only printable US-ASCII characters other than ";" and "="'
  }

  const prefixed = name.toLowerCase()
  const secure = attributes.secure === true
  const hostScoped = attributes.path === '/' && !attributes.domain

  if (prefixed.startsWith('__host-http-')) {
    if (!secure || attributes.httpOnly !== true || !hostScoped) {
      return 'a "__Host-Http-" cookie needs Secure, HttpOnly, Path=/ and no Domain'
    }
  } else if (prefixed.startsWith('__host-')) {
    if (!secure || !hostScoped) {
      return 'a "__Host-" cookie needs Secure, Path=/ and no Domain'
    }
  } else if (prefixed.startsWith('__http-')) {
    if (!secure || attributes.httpOnly !== true) {
      return 'a "__Http-" cookie needs Secure and HttpOnly'
    }
  } else if (prefixed.startsWith('__secure-') && !secure) {
    return 'a "__Secure-" cookie needs Secure'
  }

  if (typeof attributes.sameSite === 'string' && attributes.sameSite.toLowerCase() === 'none' && !secure) {
    return 'SameSite=None needs Secure'
  }

  if (attributes.partitioned === true && !secure) {
    return 'Partitioned needs Secure'
  }

  for (const [attribute, value] of [
    ['Domain', attributes.domain],
    ['Path', attributes.path],
  ] as const) {
    if (value !== undefined && encoder.encode(value).length > MAX_ATTRIBUTE_OCTETS) {
      return `its ${attribute} is longer than ${MAX_ATTRIBUTE_OCTETS} bytes`
    }
  }

  return undefined
}
