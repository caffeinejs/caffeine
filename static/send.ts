import { Readable } from 'node:stream'

import { ErrHTTPNotFound, Responder, type ActionResult, type IContext } from '@caffeinejs/http'
import type { FastifyReply } from 'fastify'

import { resolveRoot } from './builder.js'
import type { StaticRoot } from './config.js'
import { ErrSendFileUnavailable } from './errors.js'
import { serveFile, writeHeaders, type FileLog, type PreparedFile } from './serve.js'
import { kStaticMounts, type ServedMount } from './static.js'

/**
 * The slice of an `IContext` {@link sendFile} reaches through.
 *
 * A structural slice rather than `Context` from `@caffeinejs/http/fastify`: every instantiation of that class
 * fits without variance trouble, and a context built by another adapter does not compile.
 */
export interface StaticContext {
  readonly platform: { readonly reply: FastifyReply }
}

/**
 * Sends a file a `staticFiles(...)` mount lists, from a handler: the handler returns what this returns.
 *
 * The answer is the one the mount's own route gives, `Accept-Encoding`, preconditions and a range included, with
 * `Cache-Control` always `private`: this cannot see the gate of the route that called it. A file `unrouted` keeps off
 * the router is sent all the same. Preconditions and ranges apply to a `GET` or a `HEAD` the handler left at `200`; a
 * status it set is kept, with the whole file.
 *
 * `path` is the manifest's key as written, such as `'100%.txt'`, or, with a leading `/`, a URL path: the slash is
 * dropped and each segment percent-decoded, so `'/100%25.txt'` names the same file. A decoded segment holding a `/`
 * names nothing. A path the manifest does not list, `..` included, is a `404`. `root` picks the mount by the root its
 * `.serve(...)` was given; without it, the first mount.
 *
 * @throws {@link ErrSendFileUnavailable} when no `staticFiles(...)` is installed, or no mount serves `root`
 * @throws `ErrHTTPNotFound` when the mount lists no such file
 * @example
 * ```ts
 * .get('/*', ctx => (isDocumentRequest(ctx) ? sendFile(ctx, 'index.html', DIST) : notFound(ctx)))
 * ```
 */
export function sendFile(ctx: StaticContext, path: string, root?: StaticRoot): Responder {
  const reply = ctx.platform.reply
  const served = (reply.server as unknown as Record<symbol, { mounts: readonly ServedMount[] } | undefined>)[
    kStaticMounts
  ]

  if (served === undefined) {
    throw new ErrSendFileUnavailable()
  }

  const mount =
    root === undefined ? served.mounts[0] : served.mounts.find(({ root: served }) => served === resolveRoot(root))

  if (mount === undefined) {
    throw new ErrSendFileUnavailable(root === undefined ? undefined : resolveRoot(root), true)
  }

  const key = manifestKey(path)
  const file = key === undefined ? undefined : mount.files.get(key)

  if (file === undefined) {
    throw new ErrHTTPNotFound()
  }

  return new FileResponder(file, reply.log)
}

class FileResponder extends Responder {
  constructor(
    readonly file: PreparedFile,
    readonly log: FileLog,
  ) {
    super()
  }

  async respond(ctx: IContext): Promise<ActionResult> {
    const method = ctx.req.method
    const conditional = (method === 'GET' || method === 'HEAD') && ctx.statusCode === 200
    // Read before the open: it aborts when the handler times out or the client leaves while the file opens.
    const signal = ctx.signal
    const decision = await serveFile(
      this.file,
      { method, header: name => ctx.req.header(name) },
      { via: 'sendFile', conditional, log: this.log },
    )

    // Nothing will send the file, so nothing would close it.
    if (signal.aborted) {
      decision.body?.destroy()

      return undefined
    }

    writeHeaders(ctx.status(conditional ? decision.status : ctx.statusCode), decision.headers)

    if (decision.cacheControl !== undefined) {
      ctx.header('cache-control', decision.cacheControl)
    }

    // Fastify answers a `HEAD` of a compiled route through the `GET`, and writes `Content-Length: 0` for an empty
    // payload: an empty stream keeps the length the file has. A `304` has no length to keep, and a stream would have
    // the adapter label it `application/octet-stream`.
    return (
      decision.body ??
      (method === 'HEAD' && decision.headers['content-length'] !== undefined ? Readable.from([]) : undefined)
    )
  }
}

/** The manifest key `path` names: itself, or for a URL path, the path without its leading `/`, each segment decoded. */
function manifestKey(path: string): string | undefined {
  if (!path.startsWith('/')) {
    return path
  }

  try {
    const segments = path
      .slice(1)
      .split('/')
      .map(segment => decodeURIComponent(segment))

    return segments.some(segment => segment.includes('/')) ? undefined : segments.join('/')
  } catch {
    return undefined
  }
}
