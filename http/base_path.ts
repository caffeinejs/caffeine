import { ErrConfiguration } from './error/common.js'
import { solutions } from './error/util.js'
import { normalizeGroupPath } from './routing/builder.js'

const SLASH = 47
const QUESTION_MARK = 63
const BACKSLASH = 92
const TILDE = 126

/**
 * Where the adapter records, on the raw request, the base it took off the path. Absent when it took none, so a
 * request the base path did not match costs no write.
 */
export const kRawBasePath: unique symbol = Symbol('caffeine.http.basePath')

/** A raw request the base path may have been taken off. */
export interface BasePathCarrier {
  [kRawBasePath]?: string
}

/**
 * Turns what `.basePath(...)` resolved to into the base the server strips, or `undefined` when there is none.
 *
 * Trailing slashes are dropped, so `'/'` and `''` mean no base at all.
 *
 * @throws ErrConfiguration when the value does not start with "/", or holds a "?" or a "#": such a base could
 *   never match the path of a request. Also when it starts with "//" or "/\", or holds a control character: put in
 *   front of a redirect, such a base would send the browser off the origin.
 */
export function normalizeBasePath(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }

  const base = normalizeGroupPath(value)
  if (base === '') {
    return undefined
  }

  if (base.charCodeAt(0) !== SLASH) {
    throw new ErrConfiguration(
      `Cannot set the base path: "${value}" does not start with "/"` + solutions(`Write it as "/${base}"`),
    )
  }

  // A browser reads a URL starting with `//` or `/\` as naming another host, and drops tabs and line breaks before it
  // reads one, so a control character can smuggle the same start past the check.
  const second = base.charCodeAt(1)
  if (second === SLASH || second === BACKSLASH) {
    throw new ErrConfiguration(
      `Cannot set the base path: "${value}" starts with "${base.slice(0, 2)}"` +
        solutions('Start it with a single "/": a browser reads "//" or "/\\" as the start of another host'),
    )
  }

  for (let i = 0; i < base.length; i++) {
    const code = base.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) {
      throw new ErrConfiguration(
        `Cannot set the base path: ${JSON.stringify(value)} contains a control character` +
          solutions('Give the base path as path segments only'),
      )
    }
  }

  for (const char of ['?', '#']) {
    if (base.includes(char)) {
      throw new ErrConfiguration(
        `Cannot set the base path: "${value}" contains "${char}"` +
          solutions('Give the base path as path segments only, without a query or a fragment'),
      )
    }
  }

  return base
}

/**
 * The URL with `base` taken off its front, or `undefined` when the URL is not under `base`.
 *
 * `base` must end on a segment boundary of the URL — `/api` strips `/api`, `/api/pets` and `/api?x=1`, never
 * `/apix`. The comparison is on the URL as sent, so it is case-sensitive and an encoded `%2F` is not a boundary.
 * What comes back always starts with "/", and the query string is returned exactly as it arrived.
 */
export function stripBasePath(url: string, base: string): string | undefined {
  if (!url.startsWith(base)) {
    return undefined
  }

  if (url.length === base.length) {
    return '/'
  }

  const next = url.charCodeAt(base.length)

  if (next === SLASH) {
    return url.slice(base.length)
  }

  if (next === QUESTION_MARK) {
    return `/${url.slice(base.length)}`
  }

  return undefined
}

/**
 * A URL for the browser, with a leading `~/` resolved against `basePath`: `~/done` is `/api/done` under `/api`,
 * and `/done` with no base path. Anything else is returned as it is.
 *
 * `~/` followed by another `/`, a `\` or a control character is left as it is too. Resolved, each would start
 * with `//` once a browser has read it — it drops tabs and line breaks from a URL — which is a protocol-relative
 * URL sending the browser off the origin.
 */
export function resolveAppURL(url: string, basePath: string): string {
  if (url.charCodeAt(0) !== TILDE || url.charCodeAt(1) !== SLASH) {
    return url
  }

  const next = url.charCodeAt(2)
  if (next === SLASH || next === BACKSLASH || next < 0x20 || next === 0x7f) {
    return url
  }

  return basePath + url.slice(1)
}
