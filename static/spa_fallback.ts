import { FastifyContext, NotFoundFallback, type NotFoundContext } from '@caffeinejs/http'
import type { SPASettings } from './spa.js'
import { underPrefix } from './spa.js'

/** The slice of `reply` that `@fastify/static` decorates, mirroring how `@caffeinejs/view` reaches `view`. */
interface SendFileCapableReply {
  sendFile(path: string, root: string): unknown
}

/**
 * Serves the SPA shell for a client-side route.
 *
 * The order of the checks is the design. A history fallback that answers every 404 with `index.html` poisons
 * everything it touches: a missing hashed asset comes back as HTML served under a JavaScript content type,
 * and an API typo comes back as a document. So the shell is the *last* thing tried, and only for a request
 * that looks like a browser navigating to a path the server does not own and that names no file.
 */
export class SPAFallback extends NotFoundFallback {
  readonly name = 'spa'

  /** Prefixes of the other static mounts — a miss under one of those is a missing file, not a route. */
  #otherMountPrefixes: readonly string[] = []
  /** Inert until the extension confirms the shell is on disk, so a skipped mount serves nothing. */
  #enabled = false

  constructor(readonly settings: SPASettings) {
    super()
  }

  configure(otherMountPrefixes: readonly string[], enabled: boolean): void {
    this.#otherMountPrefixes = otherMountPrefixes
    this.#enabled = enabled
  }

  handle(ctx: NotFoundContext): boolean | Promise<boolean> {
    if (!this.#enabled || !this.#shouldServeShell(ctx)) {
      return false
    }

    // Through `sendFile`, not a raw stream, so the shell gets the same ETag, range and cache-header handling
    // as every other file the mount serves.
    const reply = (ctx.http as FastifyContext).reply as SendFileCapableReply
    reply.sendFile(this.settings.index, this.settings.root)

    return true
  }

  #shouldServeShell(ctx: NotFoundContext): boolean {
    const method = ctx.http.req.method

    // A navigation is a GET. A POST to a client route is a mistake, and answering it with a document hides it.
    if (method !== 'GET' && method !== 'HEAD') {
      return false
    }

    if (!underPrefix(ctx.path, this.settings.prefix)) {
      return false
    }

    // `include` is the deliberate override, so it is checked before anything that could exclude the path.
    if (this.settings.include.some(prefix => underPrefix(ctx.path, prefix))) {
      return this.#looksLikeDocument(ctx)
    }

    if (this.settings.derive && ctx.serverOwned) {
      return false
    }

    if (this.settings.exclude.some(prefix => underPrefix(ctx.path, prefix))) {
      return false
    }

    if (this.#otherMountPrefixes.some(prefix => prefix !== '' && underPrefix(ctx.path, prefix))) {
      return false
    }

    return this.#looksLikeDocument(ctx)
  }

  #looksLikeDocument(ctx: NotFoundContext): boolean {
    return !namesAFile(ctx.path) && (!this.settings.navigationOnly || isNavigation(ctx))
  }
}

/**
 * Whether the last segment carries a file extension.
 *
 * This is what keeps a missing `/assets/app-eZr2sdaR.js` a real 404: the browser asked for a script, and
 * handing it the shell would fail later and further away, as a syntax error inside a file that is not
 * JavaScript. `.html` is allowed through, since `/about.html` is a plausible client route.
 */
function namesAFile(path: string): boolean {
  const lastSegment = path.slice(path.lastIndexOf('/') + 1)
  const dot = lastSegment.lastIndexOf('.')

  if (dot <= 0) {
    return false
  }

  return lastSegment.slice(dot + 1).toLowerCase() !== 'html'
}

/**
 * Whether the request is a document navigation rather than a programmatic fetch.
 *
 * `Sec-Fetch-Dest` is the reliable signal and every current browser sends it: `document` for a navigation,
 * `empty` for `fetch()`/XHR. `Accept` is the fallback for older clients, and a request carrying neither is
 * something like curl or a test, which is allowed through rather than second-guessed.
 */
function isNavigation(ctx: NotFoundContext): boolean {
  const dest = ctx.http.req.header('sec-fetch-dest')

  if (dest != null) {
    return dest === 'document'
  }

  const accept = ctx.http.req.header('accept')

  if (accept != null) {
    return accept.includes('text/html') || accept.includes('*/*')
  }

  return true
}
