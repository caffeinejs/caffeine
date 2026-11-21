import type { Responder } from '@caffeinejs/http'

import { resolveRoot } from './builder.js'
import type { StaticRoot } from './config.js'
import { sendMountedFile, type StaticContext } from './http/http.js'
import type { VerifiedStaticAssets } from './web/web.js'

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
 * `.serve(...)` was given. Pass the verified handle to select a source mount and use an exact manifest key. Without
 * a selector, the first mount is used. On a request no route matched, there is no route to find the mounts by.
 *
 * @throws {@link ErrSendFileUnavailable} when no `staticFiles(...)` is installed, no mount serves `root`, or on a
 *   request no route matched
 * @throws `ErrHTTPNotFound` when the mount lists no such file
 * @example
 * ```ts
 * .get('/*', ctx => (isDocumentRequest(ctx) ? sendFile(ctx, 'index.html', DIST) : notFound(ctx)))
 * ```
 */
export function sendFile(ctx: StaticContext, path: string, root?: StaticRoot | VerifiedStaticAssets): Responder {
  const selector = typeof root === 'string' || root instanceof URL ? resolveRoot(root) : root
  return sendMountedFile(ctx, path, selector)
}
