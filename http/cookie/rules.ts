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

// cookie@2's own rules: a name of printable US-ASCII but ";" and "=", a domain of letter-digit-hyphen labels, and a
// path of printable US-ASCII and spaces but ";" and "<". A cookie they refuse is one cookie@2 refuses to write.
const NAME = /^[!-:<>-~]+$/
const DOMAIN = /^([.]?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i
const PATH = /^[ -:=-~]*$/

// RFC 6265bis §5.6: a user agent ignores an attribute whose value is longer.
const MAX_ATTRIBUTE_OCTETS = 1024

// Longest first: a "__Host-Http-" name is a "__Host-" one too.
const PREFIXES: ReadonlyArray<{
  readonly prefix: string
  readonly holds: (attributes: CookieAttributes) => boolean
  readonly rule: string
}> = [
  {
    prefix: '__host-http-',
    holds: a => a.secure === true && a.httpOnly === true && hostScoped(a),
    rule: 'a "__Host-Http-" cookie needs Secure, HttpOnly, Path=/ and no Domain',
  },
  {
    prefix: '__host-',
    holds: a => a.secure === true && hostScoped(a),
    rule: 'a "__Host-" cookie needs Secure, Path=/ and no Domain',
  },
  {
    prefix: '__http-',
    holds: a => a.secure === true && a.httpOnly === true,
    rule: 'a "__Http-" cookie needs Secure and HttpOnly',
  },
  {
    prefix: '__secure-',
    holds: a => a.secure === true,
    rule: 'a "__Secure-" cookie needs Secure',
  },
]

/** Whether `name` is one a `Set-Cookie` header can carry. */
export function isCookieName(name: string): boolean {
  return NAME.test(name)
}

/**
 * Why a browser would drop or misread a cookie with this name and these attributes, or `undefined` when none would.
 *
 * Covers the name, the prefixes (`__Secure-`, `__Host-`, and the `__Http-` and `__Host-Http-` that Chromium enforces),
 * `SameSite=None` and `Partitioned` without `Secure`, and the syntax and length of Domain and Path. Prefixes are
 * matched case-insensitively, as user agents match them (RFC 6265bis §5.4).
 */
export function cookieRuleViolation(name: string, attributes: CookieAttributes): string | undefined {
  return (
    nameViolation(name) ??
    prefixViolation(name, attributes) ??
    secureViolation(attributes) ??
    attributeViolation(attributes)
  )
}

function nameViolation(name: string): string | undefined {
  if (name === '') {
    return 'a cookie needs a name'
  }

  return isCookieName(name) ? undefined : 'its name may hold only printable US-ASCII characters other than ";" and "="'
}

function prefixViolation(name: string, attributes: CookieAttributes): string | undefined {
  const lower = name.toLowerCase()
  const prefix = PREFIXES.find(entry => lower.startsWith(entry.prefix))

  return prefix === undefined || prefix.holds(attributes) ? undefined : prefix.rule
}

function secureViolation({ secure, sameSite, partitioned }: CookieAttributes): string | undefined {
  if (secure === true) {
    return undefined
  }

  if (typeof sameSite === 'string' && sameSite.toLowerCase() === 'none') {
    return 'SameSite=None needs Secure'
  }

  return partitioned === true ? 'Partitioned needs Secure' : undefined
}

// An empty Domain or Path is left out of the header, as cookie@2 leaves it out.
function attributeViolation({ domain, path }: CookieAttributes): string | undefined {
  if (domain && !DOMAIN.test(domain)) {
    return 'its Domain is not a valid domain name'
  }

  if (path && !PATH.test(path)) {
    return 'its Path may hold only spaces and printable US-ASCII characters other than ";" and "<"'
  }

  // Both are ASCII by now, so each character is one octet.
  for (const [attribute, value] of [
    ['Domain', domain],
    ['Path', path],
  ] as const) {
    if (value !== undefined && value.length > MAX_ATTRIBUTE_OCTETS) {
      return `its ${attribute} is longer than ${MAX_ATTRIBUTE_OCTETS} bytes`
    }
  }

  return undefined
}

function hostScoped(attributes: CookieAttributes): boolean {
  return attributes.path === '/' && !attributes.domain
}
