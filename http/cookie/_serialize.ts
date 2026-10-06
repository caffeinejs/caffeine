import { parseCookie, stringifySetCookie, type SetCookie } from 'cookie'

import { ErrInvalidCookie } from './errors.js'
import type { CookieParseOptions, CookieSerializeOptions } from './options.js'
import { cookieRuleViolation, isCookieName } from './rules.js'
import type { CookieSecret } from './signer.js'

export type CookieOperation = 'set' | 'delete'

type Attributes = Omit<SetCookie, 'name' | 'value'>

/** A cookie checked and ready to write, but for its value. */
export interface PreparedCookie {
  readonly name: string
  /** Two cookies with the same key are one cookie to a browser: the later one replaces the earlier in a response. */
  readonly key: string
  readonly attributes: Attributes
  readonly encode: ((value: string) => string) | undefined
  readonly signed: boolean
  readonly secret: CookieSecret | undefined
}

// RFC 6265bis §5.6: a user agent drops a cookie whose name and value add up to more.
const MAX_NAME_VALUE_OCTETS = 4096

const EPOCH = new Date(0)
const encoder = new TextEncoder()

/**
 * The options every cookie of a server starts from, and the decoder its reads use: `Path=/` and `SameSite=Lax`, under
 * whatever `parseOptions` set. Computed once, when the plugin registers.
 */
export function cookieDefaults(parseOptions: CookieParseOptions | undefined): {
  defaults: CookieSerializeOptions
  decode: ((value: string) => string | undefined) | undefined
} {
  const { decode, ...rest } = parseOptions ?? {}

  return { defaults: { path: '/', sameSite: 'lax', ...rest }, decode }
}

/**
 * Checks a cookie and settles its attributes: the call's options over the server's defaults, `'auto'` decided against
 * the request, and the expiry a deletion needs.
 *
 * @throws ErrInvalidCookie when a browser would drop or misread the cookie.
 */
export function prepareCookie(
  op: CookieOperation,
  name: string,
  defaults: CookieSerializeOptions,
  options: CookieSerializeOptions | undefined,
  https: boolean,
): PreparedCookie {
  const merged = options === undefined ? defaults : { ...defaults, ...options }
  const auto = merged.secure === 'auto'
  const secure = merged.secure === 'auto' ? https : merged.secure

  // A browser drops `SameSite=None` without `Secure`, so on a plain-HTTP request `'auto'` falls back to the default.
  const sameSite =
    auto && !https && typeof merged.sameSite === 'string' && merged.sameSite.toLowerCase() === 'none'
      ? 'lax'
      : merged.sameSite

  const attributes: Attributes = {
    domain: merged.domain,
    path: merged.path,
    expires: op === 'delete' ? EPOCH : expiry(op, name, merged.expires),
    maxAge: op === 'delete' ? 0 : merged.maxAge,
    httpOnly: merged.httpOnly,
    secure,
    sameSite,
    partitioned: merged.partitioned,
    priority: merged.priority,
  }

  const violation = cookieRuleViolation(name, attributes)
  if (violation !== undefined) {
    throw new ErrInvalidCookie(`Cannot ${op} ${describeCookie(name)}: ${violation}`)
  }

  const signed = op === 'set' && (merged.secret !== undefined || merged.signed === true)

  return {
    name,
    key: `${name};${normalizedDomain(attributes.domain)};${attributes.path ?? ''};${attributes.partitioned === true}`,
    attributes,
    encode: merged.encode,
    signed,
    secret: signed ? merged.secret : undefined,
  }
}

/**
 * The `Set-Cookie` line for a prepared cookie.
 *
 * A value that cannot be carried is reported without being repeated: cookie@2 names it in its own message, and an
 * error's cause can reach a client.
 *
 * @throws ErrInvalidCookie when an attribute or the encoded value cannot be written, or the cookie is too large.
 */
export function serializeCookie(op: CookieOperation, prepared: PreparedCookie, value: string): string {
  let line: string

  try {
    line = stringifySetCookie(
      // A deletion carries no value, whatever it was handed.
      { ...prepared.attributes, name: prepared.name, value: op === 'delete' ? '' : value },
      prepared.encode === undefined ? undefined : { encode: prepared.encode },
    )
  } catch (err) {
    if (!(err instanceof TypeError)) {
      throw err
    }

    throw new ErrInvalidCookie(`Cannot ${op} ${describeCookie(prepared.name)}: ${reasonOf(err)}`)
  }

  const end = line.indexOf(';')
  // The `=` between them is not part of either.
  const size = encoder.encode(end < 0 ? line : line.slice(0, end)).length - 1

  if (size > MAX_NAME_VALUE_OCTETS) {
    throw new ErrInvalidCookie(
      `Cannot ${op} ${describeCookie(prepared.name)}: its name and value come to ${size} bytes, past the ` +
        `${MAX_NAME_VALUE_OCTETS} a browser keeps`,
    )
  }

  return line
}

/**
 * Checks the attributes of a cookie whose value is not known yet — one waiting to be signed — so a bad option fails
 * where it was written rather than when the response goes out.
 *
 * @throws ErrInvalidCookie when an attribute cannot be written.
 */
export function assertWritable(op: CookieOperation, prepared: PreparedCookie): void {
  serializeCookie(op, prepared, '')
}

/** The cookies a `Cookie` header carries. The first of two cookies sharing a name wins, as a browser sends the more specific first. */
export function parseCookies(
  header: string | undefined,
  decode: ((value: string) => string | undefined) | undefined,
): Record<string, string> {
  return parseCookie(header ?? '', decode === undefined ? undefined : { decode }) as Record<string, string>
}

function expiry(op: CookieOperation, name: string, expires: Date | number | undefined): Date | undefined {
  if (expires === undefined) {
    return undefined
  }

  const date = typeof expires === 'number' ? new Date(expires) : expires
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new ErrInvalidCookie(`Cannot ${op} ${describeCookie(name)}: its expiry is not a valid date`)
  }

  return date
}

function normalizedDomain(domain: string | undefined): string {
  if (domain === undefined) {
    return ''
  }

  const lower = domain.toLowerCase()
  return lower.startsWith('.') ? lower.slice(1) : lower
}

/** How an error names a cookie. A name a header cannot carry is not repeated: it may hold anything, a line break included. */
export function describeCookie(name: string): string {
  return isCookieName(name) ? `cookie "${name}"` : 'a cookie with an invalid name'
}

const REASONS: ReadonlyArray<readonly [prefix: string, reason: string]> = [
  ['argument name', 'its name may hold only printable US-ASCII characters other than ";" and "="'],
  ['argument val', 'its value, once encoded, holds characters a cookie cannot carry'],
  ['option maxAge', 'its Max-Age is not a whole number of seconds'],
  ['option domain', 'its Domain is not a valid domain name'],
  ['option path', 'its Path may hold only spaces and printable US-ASCII characters other than ";" and "<"'],
  ['option expires', 'its expiry is not a valid date'],
  ['option priority', 'its Priority is not "low", "medium" or "high"'],
  ['option sameSite', 'its SameSite is not "strict", "lax" or "none"'],
]

function reasonOf(err: TypeError): string {
  for (const [prefix, reason] of REASONS) {
    if (err.message.startsWith(prefix)) {
      return reason
    }
  }

  return 'it cannot be written as a Set-Cookie header'
}
