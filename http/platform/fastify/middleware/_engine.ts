import type { IncomingMessage, ServerResponse } from 'node:http'

import type { MiddlewarePath, Next, NodeMiddleware } from '../../../core/middleware/middleware.js'
import { compilePrefix, mountedURL, normalizePath, sanitizeURL, type PathFlags } from '../../../core/middleware/path.js'
import { rawContext } from '../../../core/middleware/raw_context.js'

// A connect-style chain for one hook. Path matching normalizes the URL the way Fastify's router does, so a
// path-scoped middleware cannot be skipped by a request the router still sends to the guarded route.

export interface Engine {
  use(path: MiddlewarePath | undefined, fn: NodeMiddleware): void
  run(req: IncomingMessage, res: ServerResponse, done: Next): void
}

interface Layer {
  readonly regexp: RegExp | undefined
  readonly fn: NodeMiddleware
}

type RawRequest = IncomingMessage & { url: string; originalUrl?: string }

export function createEngine(flags: PathFlags): Engine {
  const layers: Layer[] = []

  return {
    use(path, fn) {
      layers.push({ regexp: path === undefined ? undefined : compilePrefix(path), fn })
    },

    run(req, res, done) {
      if (layers.length === 0) {
        done()
        return
      }

      const raw = req as RawRequest
      const originalURL = raw.url
      // Kept when already set: the server saved the full URL there before taking a base path off `url`.
      raw.originalUrl ??= originalURL

      const normalized = normalizePath(sanitizeURL(originalURL), flags)
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

        raw.url = mountedURL(layer.regexp, originalURL, normalized.path, match, flags)
        layer.fn(raw, res, next)
      }

      next(normalized.error)
    },
  }
}
