import { ErrHTTPNotFound, type Responder, type RouteDefinition } from '@caffeinejs/http'

import { resolveRoot } from './builder.js'
import type { StaticRoot } from './config.js'
import { ErrSendFileUnavailable } from './errors.js'
import { FileResponder } from './serve.js'
import { mountsByRoute } from './static.js'

/**
 * The slice of an `IContext` {@link sendFile} reads: the route, whose server's mounts it sends from. A structural
 * slice, so every context fits.
 */
export interface StaticContext {
  readonly route: RouteDefinition | undefined
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
 * `.serve(...)` was given; without it, the first mount. On a request no route matched, such as one an error handler
 * answers, there is no route to find the mounts by.
 *
 * @throws {@link ErrSendFileUnavailable} when no `staticFiles(...)` is installed, no mount serves `root`, or on a
 *   request no route matched
 * @throws `ErrHTTPNotFound` when the mount lists no such file
 * @example
 * ```ts
 * .get('/*', ctx => (isDocumentRequest(ctx) ? sendFile(ctx, 'index.html', DIST) : notFound(ctx)))
 * ```
 */
export function sendFile(ctx: StaticContext, path: string, root?: StaticRoot): Responder {
  const route = ctx.route

  if (route === undefined) {
    throw new ErrSendFileUnavailable(undefined, false, false)
  }

  const served = mountsByRoute.get(route)

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

  return new FileResponder(file, 'sendFile', served.log)
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
