import { solutions } from '../error/util.js'
import { ErrCSRFConfiguration } from './errors.js'

/**
 * The methods a request may use without changing state, which the cross-origin check therefore never refuses: the
 * safe methods of RFC 9110, and `QUERY`. An application that changes state on one of them has no protection to rely
 * on.
 */
export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE', 'QUERY'])

/**
 * What the headers of a request say of where it came from. `unknown` is a request carrying neither `Sec-Fetch-Site`
 * nor `Origin`: a non-browser client, or a browser too old to send either.
 */
export type OriginVerdict = 'allow' | 'deny' | 'unknown'

/** What decided a verdict. */
export type OriginReason =
  | 'safe-method'
  | 'same-origin'
  | 'trusted-origin'
  | 'sec-fetch-site'
  | 'origin-null'
  | 'origin-malformed'
  | 'origin-mismatch'
  | 'scheme-downgrade'
  | 'no-browser-headers'

/** What the check reads of a request. */
export interface OriginCheckInput {
  /** As the request line spells it: `POST`, never `post`. */
  method: string
  /** The `Sec-Fetch-Site` header as sent; `undefined` or empty when the request carries none. */
  secFetchSite?: string | undefined
  /** The `Origin` header as sent; `undefined` or empty when the request carries none. */
  origin?: string | undefined
  /** The authority the server trusts for the request, `host[:port]`, as `ctx.req.host` answers it. */
  host: string
  /** `http` or `https`, as `ctx.req.protocol` answers it. */
  protocol: string
}

export interface OriginCheckOptions {
  /** Origins a cross-origin request may come from, each as {@link normalizeTrustedOrigin} spells it. */
  trustedOrigins: ReadonlySet<string>
}

export interface OriginCheckResult {
  verdict: OriginVerdict
  reason: OriginReason
}

/**
 * Judges one request by its Fetch Metadata, as Go's `net/http` cross-origin protection does.
 *
 * A safe method is allowed. `Sec-Fetch-Site: same-origin` or `none` is allowed; any other value is refused unless the
 * `Origin` is trusted, `same-site` included, since a sibling subdomain is not this origin. Without that header the
 * `Origin` decides: absent, the verdict is `unknown`; `null` or malformed is refused; a trusted one is allowed; an
 * `http:` origin on a request the server knows came over HTTPS is refused; one naming the request's own host is
 * allowed; any other is refused. Hosts compare case-insensitively, with a default port taken off.
 */
export function checkOrigin(input: OriginCheckInput, options: OriginCheckOptions): OriginCheckResult {
  if (SAFE_METHODS.has(input.method)) {
    return { verdict: 'allow', reason: 'safe-method' }
  }

  const site = input.secFetchSite
  if (site !== undefined && site !== '') {
    if (site === 'same-origin' || site === 'none') {
      return { verdict: 'allow', reason: 'same-origin' }
    }

    // `cross-site`, `same-site`, and anything a browser would not write.
    return isTrusted(input.origin, options)
      ? { verdict: 'allow', reason: 'trusted-origin' }
      : { verdict: 'deny', reason: 'sec-fetch-site' }
  }

  const origin = input.origin
  if (origin === undefined || origin === '') {
    return { verdict: 'unknown', reason: 'no-browser-headers' }
  }

  if (origin === 'null') {
    return { verdict: 'deny', reason: 'origin-null' }
  }

  const parsed = parseOrigin(origin)
  if (parsed === undefined) {
    return { verdict: 'deny', reason: 'origin-malformed' }
  }

  if (options.trustedOrigins.has(parsed.origin)) {
    return { verdict: 'allow', reason: 'trusted-origin' }
  }

  // Known HTTPS and an `http:` origin is never same-origin. The reverse is left alone: a proxy that ended TLS and
  // was not trusted reports `http`, and refusing it would refuse every old browser behind it.
  if (input.protocol === 'https' && parsed.protocol === 'http:') {
    return { verdict: 'deny', reason: 'scheme-downgrade' }
  }

  if (parsed.host === normalizeHost(input.host, input.protocol)) {
    return { verdict: 'allow', reason: 'same-origin' }
  }

  return { verdict: 'deny', reason: 'origin-mismatch' }
}

/**
 * Spells a trusted origin the way an `Origin` header does, `scheme://host[:port]`, lower-cased and without a default
 * port: `HTTPS://Admin.Example:443/` is `https://admin.example`.
 *
 * @throws ErrCSRFConfiguration when `text` is not an absolute `http` or `https` URL, or carries a path, a query, a
 * fragment or credentials.
 */
export function normalizeTrustedOrigin(text: string): string {
  let url: URL

  try {
    url = new URL(text)
  } catch {
    throw new ErrCSRFConfiguration(
      `Cannot trust origin "${text}": it is not an absolute URL` +
        solutions('Write it as scheme://host[:port], e.g. "https://admin.example.com"'),
    )
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ErrCSRFConfiguration(`Cannot trust origin "${text}": only an http or https origin can be trusted`)
  }

  // The URL parser takes `*` for a host character, so a pattern would be trusted as a host nobody has.
  if (url.hostname.includes('*')) {
    throw new ErrCSRFConfiguration(
      `Cannot trust origin "${text}": a trusted origin is exact, with no wildcard` +
        solutions('List every origin to trust'),
    )
  }

  // An origin and a slash: the one spelling a URL of nothing but scheme, host and port has.
  if (url.href !== `${url.origin}/`) {
    throw new ErrCSRFConfiguration(
      `Cannot trust origin "${text}": an origin is a scheme, a host and a port, with no path, query, fragment or ` +
        'credentials' +
        solutions(`Write it as "${url.origin}"`),
    )
  }

  return url.origin
}

function isTrusted(origin: string | undefined, options: OriginCheckOptions): boolean {
  if (origin === undefined || origin === '' || options.trustedOrigins.size === 0) {
    return false
  }

  const parsed = parseOrigin(origin)

  return parsed !== undefined && options.trustedOrigins.has(parsed.origin)
}

// A URL whose origin is one: a scheme the platform knows, with a host. The path a non-browser might send along is
// ignored, as Go ignores it; what is compared is the host.
function parseOrigin(origin: string): URL | undefined {
  try {
    const url = new URL(origin)

    return url.origin === 'null' ? undefined : url
  } catch {
    return undefined
  }
}

// Lower-cased, and without the port the scheme implies, which `URL` takes off the origin's host as well.
function normalizeHost(host: string, protocol: string): string {
  const lower = host.toLowerCase()
  const defaultPort = protocol === 'https' ? ':443' : protocol === 'http' ? ':80' : undefined

  return defaultPort !== undefined && lower.endsWith(defaultPort) ? lower.slice(0, -defaultPort.length) : lower
}
