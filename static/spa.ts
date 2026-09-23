import { isAbsolute, relative, sep } from 'node:path'

import { isNavigation } from '@caffeinejs/http'

import type { StaticMount } from './config.js'

/** The slice of a `Context` {@link isDocumentRequest} reads. */
export interface DocumentRequestContext {
  readonly req: {
    readonly url: string
    header(key: string): string | undefined
  }
}

/**
 * Whether a request that matched no route of its own should be answered with a single-page application's
 * shell document.
 *
 * Two rules, both of which fail quietly when an application writes them by hand:
 *
 * - a path whose last segment carries an extension other than `.html` names a **file**, so a missing
 *   `/assets/app-eZr2sdaR.js` stays a 404 rather than returning HTML under a JavaScript content type.
 *   `.html` passes, since `/about.html` is a plausible client route;
 * - unless `navigationOnly` is false, only a browser navigation gets a document, decided by `isNavigation`
 *   from `@caffeinejs/http` — the same rule an authentication scheme redirects on, so a request cannot be
 *   redirected to sign in by one and answered `404` by the other. `Accept: *`&#47;`*` alone is not a
 *   navigation, which is what curl, axios and kube-probe send. A request carrying neither Fetch Metadata nor
 *   `Accept` has not said, and is given the shell.
 *
 * Meant for a wildcard route, which is a fallback. A path the application declared — `/`, `/index.html` — is
 * a request for the document itself and answers any client, so it needs no test.
 *
 * @example
 * ```ts
 * .get('/*', ctx => (isDocumentRequest(ctx) ? sendFile(ctx, 'index.html') : notFound(ctx)))
 * ```
 */
export function isDocumentRequest(ctx: DocumentRequestContext, navigationOnly = true): boolean {
  if (namesAFile(ctx.req.url)) {
    return false
  }

  if (!navigationOnly) {
    return true
  }

  return (
    isNavigation({
      secFetchMode: ctx.req.header('sec-fetch-mode'),
      secFetchDest: ctx.req.header('sec-fetch-dest'),
      accept: ctx.req.header('accept'),
    }) ?? true
  )
}

/**
 * Whether the last path segment carries a file extension, the query ignored.
 *
 * This is what keeps a missing `/assets/app-eZr2sdaR.js` a real 404: the browser asked for a script, and
 * handing it the shell would fail later and further away, as a syntax error inside a file that is not
 * JavaScript.
 */
function namesAFile(url: string): boolean {
  const path = url.split('?', 1)[0] ?? ''
  const lastSegment = path.slice(path.lastIndexOf('/') + 1)
  const dot = lastSegment.lastIndexOf('.')

  if (dot <= 0) {
    return false
  }

  return lastSegment.slice(dot + 1).toLowerCase() !== 'html'
}

/**
 * The `@fastify/static` options a mount serving a single-page application's files needs.
 *
 * `wildcard: false` is load-bearing rather than a tuning knob: the default installs a catch-all
 * `GET <prefix>*`, which both answers its own 404 for a miss — leaving the application's client-route
 * wildcard nothing to fall back from — and collides with that wildcard outright. With it off, the plugin
 * enumerates the real files at start-up and registers a route per file.
 *
 * `index` and `globIgnore` keep the shell document off the mount, so one route of the application's own
 * serves every spelling of it and they all carry the same `ETag`.
 *
 * Spread it and override whatever else the mount needs.
 *
 * @example
 * ```ts
 * s.serve(DIST, { ...spaMount(), preCompressed: true }, { anonymous: true })
 * ```
 */
export function spaMount(index = 'index.html'): Pick<StaticMount, 'wildcard' | 'index' | 'globIgnore'> {
  return { wildcard: false, index: false, globIgnore: [index] }
}

/**
 * A `setHeaders` callback pinning content-hashed files and revalidating everything else within the hour.
 *
 * `@fastify/static`'s `maxAge` is per **mount**, so one mount cannot say "the shell must be revalidated but
 * the hashed assets never expire" — which is exactly what a single-page application needs.
 *
 * Prefix-based rather than sniffing a hash out of the file name: a name like `my-component.js` looks hashed
 * to any such pattern, and a false positive pins a mutable file in every visitor's browser for a year with no
 * way to recall it. `prefixes` default to `['/assets']`, Vite's `build.assetsDir`, and are compared against
 * the path *within* `root`, so `/assets` means the site's assets directory rather than any directory of that
 * name higher up the filesystem.
 *
 * @param root - The mount root, so a file outside it is left alone
 */
export function immutableAssets(
  root: string,
  prefixes: readonly string[] = ['/assets'],
): NonNullable<StaticMount['setHeaders']> {
  return (reply, path) => {
    const rel = relative(root, path)

    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      return
    }

    const within = `/${rel.split(sep).join('/')}`
    const hashed = prefixes.some(prefix => within === prefix || within.startsWith(`${prefix}/`))

    reply.header('cache-control', hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=3600')
  }
}
