import type { SendOptions } from '@fastify/static'
import type { FastifyReply } from 'fastify'

import { rebaseDirectoryRedirect } from './_redirect.js'
import { ErrSendFileUnavailable } from './errors.js'

/**
 * {@link download}'s options.
 *
 * `root` is accepted although `@fastify/static`'s own `SendOptions` omits it: its `download` decorator reads
 * `root` off this object, and a relative `filepath` resolves against nothing without it.
 */
export type DownloadOptions = SendOptions & { root?: string }

/**
 * The slice of a `Context` {@link sendFile} and {@link download} reach through.
 *
 * A structural slice rather than `FastifyContext` from `@caffeinejs/http`: every instantiation of that class
 * fits without variance trouble, and a context built by another adapter does not compile.
 */
export interface StaticContext {
  readonly req: { readonly basePath: string }
  readonly platform: { readonly reply: FastifyReply }
}

/**
 * Sends a file the way `reply.sendFile` does, from a handler that holds a `Context`.
 *
 * The handler must **return** what this returns. `@fastify/static` pumps the file asynchronously without
 * awaiting it, so the context does not yet know it answered, and a handler returning `undefined` would be
 * sent over. Handing the reply back is what tells the adapter the request is taken.
 *
 * The decorating mount's `preCompressed`, `allowedPath` and `setHeaders` govern — `@fastify/static` is
 * `fastify-plugin`-wrapped, so there is one decoration per server — and `options` overrides only the
 * `@fastify/send`-level settings.
 *
 * When the decorating mount has `redirect: true`, the redirect sent for a directory carries the request's base
 * path, as a mount's own does.
 *
 * @throws {@link ErrSendFileUnavailable} when no mount decorated the reply
 * @example
 * ```ts
 * .get('/report', ctx => sendFile(ctx, 'report.pdf'))
 * ```
 */
export function sendFile(ctx: StaticContext, filename: string, rootPath?: string): FastifyReply
export function sendFile(ctx: StaticContext, filename: string, options?: SendOptions): FastifyReply
export function sendFile(ctx: StaticContext, filename: string, rootPath?: string, options?: SendOptions): FastifyReply
export function sendFile(
  ctx: StaticContext,
  filename: string,
  rootPath?: string | SendOptions,
  options?: SendOptions,
): FastifyReply {
  // The decorator disambiguates the second argument itself (`typeof rootPath === 'object'`), which its own
  // overloads cannot express to a caller forwarding both shapes.
  return decorated(ctx, 'sendFile').sendFile(filename, rootPath as string, options)
}

/**
 * Sends a file as an attachment the way `reply.download` does, from a handler that holds a `Context`.
 *
 * `filename` names the file the browser saves, defaulting to `filepath`. Everything {@link sendFile} says
 * about returning the reply and about whose options apply holds here too, with one difference worth knowing:
 * a relative `filepath` needs `options.root`, because `@fastify/static`'s decorator does not fall back to the
 * mount's own root the way its `sendFile` does.
 *
 * @throws {@link ErrSendFileUnavailable} when no mount decorated the reply
 * @example
 * ```ts
 * .get('/invoice', ctx => download(ctx, 'invoices/2026-01.pdf', 'invoice.pdf', { root: DOCS }))
 * ```
 */
export function download(ctx: StaticContext, filepath: string, options?: DownloadOptions): FastifyReply
export function download(ctx: StaticContext, filepath: string, filename?: string): FastifyReply
export function download(
  ctx: StaticContext,
  filepath: string,
  filename?: string,
  options?: DownloadOptions,
): FastifyReply
export function download(
  ctx: StaticContext,
  filepath: string,
  filename?: string | DownloadOptions,
  options?: DownloadOptions,
): FastifyReply {
  return decorated(ctx, 'download').download(filepath, filename as string, options)
}

/**
 * The reply, once it is known to carry the decoration.
 *
 * A named error rather than the `TypeError` a missing decorator would otherwise raise from inside the
 * handler, where nothing names the cause.
 *
 * Under a base path, the reply's own `redirect` is shadowed so the directory redirect `@fastify/static` builds
 * from the path the base was taken off gets it back. An application route's hooks are fixed when it registers,
 * and a server-wide hook would charge every route, so it is this one reply that is changed, and only for a
 * request that came under the base.
 */
function decorated(ctx: StaticContext, name: 'sendFile' | 'download'): FastifyReply {
  const reply = ctx.platform.reply

  if (typeof reply[name] !== 'function') {
    throw new ErrSendFileUnavailable(name)
  }

  const basePath = ctx.req.basePath

  if (basePath !== '') {
    const redirect = reply.redirect.bind(reply)

    reply.redirect = (url, code) => redirect(rebaseDirectoryRedirect(url, code, reply.request.raw.url, basePath), code)
  }

  return reply
}
