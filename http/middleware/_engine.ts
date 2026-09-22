import type { IncomingMessage, ServerResponse } from 'node:http'

import { pathToRegexp } from 'path-to-regexp'

import { ErrHTTPBadRequest } from '../error/http.js'
import { rawContext } from './_raw_context.js'
import type { MiddlewarePath, Next, NodeMiddleware } from './middleware.js'

// A connect-style chain for one hook. Path matching normalizes the URL the way Fastify's router does, so a
// path-scoped middleware cannot be skipped by a request the router still sends to the guarded route.

export interface NormalizationOptions {
  ignoreDuplicateSlashes?: boolean
  ignoreTrailingSlash?: boolean
  useSemicolonDelimiter?: boolean
}

export interface Engine {
  use(path: MiddlewarePath | undefined, fn: NodeMiddleware): void
  run(req: IncomingMessage, res: ServerResponse, done: Next): void
}

interface Layer {
  readonly regexp: RegExp | undefined
  readonly fn: NodeMiddleware
}

type RawRequest = IncomingMessage & { url: string; originalUrl?: string }

// Encoded characters where decodeURIComponent(x) !== decodeURI(x): % # $ & + , / : ; = ? @
const RESERVED_ENCODINGS = new Set(['25', '23', '24', '26', '2B', '2C', '2F', '3A', '3B', '3D', '3F', '40'])

export function createEngine(options: NormalizationOptions): Engine {
  const layers: Layer[] = []

  return {
    use(path, fn) {
      const regexp =
        path === undefined
          ? undefined
          : pathToRegexp(typeof path === 'string' ? sanitizePrefix(path) : path.map(sanitizePrefix), { end: false })
              .regexp
      layers.push({ regexp, fn })
    },

    run(req, res, done) {
      if (layers.length === 0) {
        done()
        return
      }

      const raw = req as RawRequest
      const originalURL = raw.url
      raw.originalUrl = originalURL

      const sanitized = sanitizeURL(originalURL)
      const suffix = originalURL.slice(sanitized.length)
      const normalized = normalizePath(sanitized, options)
      let i = 0

      const next = (err?: Error | null): void => {
        raw.url = originalURL

        // A middleware that answered — through the context, or on the raw response — ends the chain. The
        // context's own record is asked too: `writableEnded` stays false while an `onSend` hook that awaits
        // holds that answer open, and the handler would send a second time over it.
        if (res.writableEnded || rawContext(raw)?.sent === true) {
          return
        }

        if (err || i === layers.length) {
          done(err ?? undefined)
          return
        }

        const layer = layers[i++]
        if (layer.regexp === undefined) {
          layer.fn(raw, res, next)
          return
        }

        const match = layer.regexp.exec(normalized.path)
        if (match === null) {
          next()
          return
        }

        let url: string
        const original = layer.regexp.exec(sanitized)
        if (original !== null) {
          url = sanitized.slice(original[0].length)
          if (options.ignoreDuplicateSlashes) {
            url = removeDuplicateSlashes(url)
          }
          if (options.ignoreTrailingSlash) {
            url = trimLastSlash(url)
          }
        } else {
          url = normalized.path.slice(match[0].length)
        }
        if (url[0] !== '/') {
          url = '/' + url
        }

        raw.url = url + suffix
        layer.fn(raw, res, next)
      }

      next(normalized.error)
    },
  }
}

function sanitizeURL(url: string): string {
  for (let i = 0; i < url.length; i++) {
    const charCode = url.charCodeAt(i)
    if (charCode === 63 || charCode === 35) {
      return url.slice(0, i)
    }
  }
  return url
}

function sanitizePrefix(prefix: string): string {
  if (prefix === '/') {
    return ''
  }
  return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
}

function normalizePath(url: string, options: NormalizationOptions): { path: string; error: Error | undefined } {
  let path = url

  if (path.charCodeAt(0) !== 47) {
    const absolute = pathFromAbsoluteURL(path)
    if (absolute === null) {
      return { path: url, error: malformedURL() }
    }
    path = absolute
  }

  if (options.ignoreDuplicateSlashes) {
    path = removeDuplicateSlashes(path)
  }

  try {
    path = safeDecodeURI(path, options.useSemicolonDelimiter === true)
  } catch {
    return { path: url, error: malformedURL() }
  }

  // The router keeps encoded slashes, but a literal `%` can still introduce one more encoded byte.
  path = path.replace(/%25([0-9A-Fa-f]{2})/g, '%$1')

  if (options.ignoreTrailingSlash) {
    path = trimLastSlash(path)
  }

  return { path, error: undefined }
}

function pathFromAbsoluteURL(url: string): string | null {
  const schemeEnd = url.indexOf('://')
  if (schemeEnd === -1) {
    return url
  }

  const scheme = url.slice(0, schemeEnd).toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') {
    return url
  }

  const authorityStart = schemeEnd + 3
  const pathStart = url.indexOf('/', authorityStart)
  if (pathStart === authorityStart || !URL.canParse(url)) {
    return null
  }

  return pathStart === -1 ? '/' : url.slice(pathStart)
}

// Decodes the path the way find-my-way does: reserved encodings stay encoded, and `%25` is re-encoded so it
// is not decoded twice.
function safeDecodeURI(path: string, useSemicolonDelimiter: boolean): string {
  let shouldDecode = false

  for (let i = 1; i < path.length; i++) {
    const charCode = path.charCodeAt(i)

    if (charCode === 37) {
      const hex = path.slice(i + 1, i + 3).toUpperCase()
      if (!RESERVED_ENCODINGS.has(hex)) {
        shouldDecode = true
      } else {
        if (hex === '25') {
          shouldDecode = true
          path = path.slice(0, i + 1) + '25' + path.slice(i + 1)
          i += 2
        }
        i += 2
      }
    } else if (charCode === 63 || charCode === 35 || (charCode === 59 && useSemicolonDelimiter)) {
      path = path.slice(0, i)
      break
    }
  }

  return shouldDecode ? decodeURI(path) : path
}

function removeDuplicateSlashes(path: string): string {
  return path.includes('//') ? path.replace(/\/\/+/g, '/') : path
}

function trimLastSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

function malformedURL(): Error {
  return new ErrHTTPBadRequest('Cannot match the request path: the URL is malformed')
}
