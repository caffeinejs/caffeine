import { errMessage } from '@caffeinejs/std/framework'

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
  /** On a refusal the application's own checks may overturn, what they are asked. */
  askable?: OriginCheckAskable
}

/**
 * What the application's own checks are asked about a refusal. A request whose `Origin` is absent, `null`,
 * malformed, of another scheme, or `http:` on a request known to be HTTPS carries none: it stays refused.
 */
export interface OriginCheckAskable {
  /** The request's `Origin` as `scheme://host[:port]`, lower-cased and without a default port. */
  origin: string
  /** The `Sec-Fetch-Site` that refused the request, when it is one a browser writes for another site. */
  site?: 'same-site' | 'cross-site'
}

/**
 * Judges one request by its Fetch Metadata, as Go's `net/http` cross-origin protection does.
 *
 * A safe method is allowed. `Sec-Fetch-Site: same-origin` or `none` is allowed; any other value is refused unless the
 * `Origin` is trusted, `same-site` included, since a sibling subdomain is not this origin. Without that header the
 * `Origin` decides: absent, the verdict is `unknown`; `null`, malformed, or of a scheme other than `http` and `https`
 * is refused; a trusted one is allowed; an `http:` origin on a request the server knows came over HTTPS is refused;
 * one naming the request's own host is allowed, an `https:` one on a request seen as `http` included, as a proxy
 * that ended TLS without being trusted delivers it; any other is refused. Hosts compare case-insensitively, with a
 * default port taken off.
 *
 * A refusal carries {@link OriginCheckResult.askable} when the application's own checks may still let it through.
 */
export function checkOrigin(input: OriginCheckInput, options: OriginCheckOptions): OriginCheckResult {
  if (SAFE_METHODS.has(input.method)) {
    return { verdict: 'allow', reason: 'safe-method' }
  }

  const site = input.secFetchSite

  return site === undefined || site === '' ? judgeOrigin(input, options) : judgeSite(site, input, options)
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
      errMessage(`Cannot trust origin "${text}": it is not an absolute URL`)
        .solutions('Write it as scheme://host[:port], e.g. "https://admin.example.com"')
        .reference('@caffeinejs/http', ErrCSRFConfiguration)
        .build(),
    )
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ErrCSRFConfiguration(`Cannot trust origin "${text}": only an http or https origin can be trusted`)
  }

  // The URL parser takes `*` for a host character, so a pattern would be trusted as a host nobody has.
  if (url.hostname.includes('*')) {
    throw new ErrCSRFConfiguration(
      errMessage(`Cannot trust origin "${text}": a trusted origin is exact, with no wildcard`)
        .solutions('List every origin to trust')
        .reference('@caffeinejs/http', ErrCSRFConfiguration)
        .build(),
    )
  }

  // An origin and a slash: the one spelling a URL of nothing but scheme, host and port has.
  if (url.href !== `${url.origin}/`) {
    throw new ErrCSRFConfiguration(
      errMessage(
        `Cannot trust origin "${text}": an origin is a scheme, a host and a port, with no path, query, fragment or ` +
          'credentials',
      )
        .solutions(`Write it as "${url.origin}"`)
        .reference('@caffeinejs/http', ErrCSRFConfiguration)
        .build(),
    )
  }

  return url.origin
}

// The browser's own word on where the request came from, which no script can forge.
function judgeSite(site: string, input: OriginCheckInput, options: OriginCheckOptions): OriginCheckResult {
  if (site === 'same-origin' || site === 'none') {
    return { verdict: 'allow', reason: 'same-origin' }
  }

  // `cross-site`, `same-site`, and anything a browser would not write.
  const parsed = input.origin === undefined || input.origin === '' ? undefined : parseOrigin(input.origin)
  if (parsed !== undefined && options.trustedOrigins.has(parsed.origin)) {
    return { verdict: 'allow', reason: 'trusted-origin' }
  }

  return refused('sec-fetch-site', askableOf(parsed, input, site))
}

// A browser too old for Fetch Metadata, or no browser at all: the `Origin` decides, against the request's own host.
function judgeOrigin(input: OriginCheckInput, options: OriginCheckOptions): OriginCheckResult {
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
  // was not trusted reports `http`, and refusing it would refuse every old browser behind it. Only this host's own
  // HTTPS side can send it, and over plain HTTP a browser posting from there sends `Origin: null`, refused above,
  // unless the page itself asked for a permissive referrer policy.
  if (input.protocol === 'https' && parsed.protocol === 'http:') {
    return { verdict: 'deny', reason: 'scheme-downgrade' }
  }

  if (parsed.host === normalizeHost(input.host, input.protocol)) {
    return { verdict: 'allow', reason: 'same-origin' }
  }

  return refused('origin-mismatch', askableOf(parsed, input))
}

function refused(reason: OriginReason, askable: OriginCheckAskable | undefined): OriginCheckResult {
  return askable === undefined ? { verdict: 'deny', reason } : { verdict: 'deny', reason, askable }
}

// The application's checks are never asked about an `http:` origin on a request known to be HTTPS: that is the
// downgrade the rules refuse, which only the exact list, where the scheme is written out, may let through.
function askableOf(parsed: URL | undefined, input: OriginCheckInput, site?: string): OriginCheckAskable | undefined {
  if (parsed === undefined || (input.protocol === 'https' && parsed.protocol === 'http:')) {
    return undefined
  }

  return site === 'same-site' || site === 'cross-site' ? { origin: parsed.origin, site } : { origin: parsed.origin }
}

// The origin of a page: `http:` or `https:`, with a host. No page has a `ws:` or `ftp:` one, and a `blob:` URL would
// answer with the origin inside it. The path a non-browser might send along is ignored, as Go ignores it.
function parseOrigin(origin: string): URL | undefined {
  try {
    const url = new URL(origin)

    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined
  } catch {
    return undefined
  }
}

// The port each scheme implies, which `URL` takes off an origin's host.
const DEFAULT_PORTS: ReadonlyMap<string, string> = new Map([
  ['http', ':80'],
  ['https', ':443'],
])

// Lower-cased, and without the port the scheme implies, as `URL` spells the origin's host.
function normalizeHost(host: string, protocol: string): string {
  const lower = host.toLowerCase()
  const defaultPort = DEFAULT_PORTS.get(protocol)

  return defaultPort !== undefined && lower.endsWith(defaultPort) ? lower.slice(0, -defaultPort.length) : lower
}
