import { isNavigation } from '@caffeinejs/http'

/** The slice of an `IContext` {@link isDocumentRequest} reads. */
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
