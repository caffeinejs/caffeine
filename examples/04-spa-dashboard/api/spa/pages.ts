import { ErrHTTPNotFound, newRouter, type Context } from '@caffeinejs/http'
import { isDocumentRequest, sendFile } from '@caffeinejs/static'

import { SITE } from './site.js'

/** The shell. One document, one `ETag`, whatever client route asked for it. */
const shellDocument = (ctx: Context) => sendFile(ctx, 'index.html', SITE)

/** A miss the application refuses itself, so it renders through the error pipeline like any thrown error. */
const notFound = (ctx: Context): never => {
  throw new ErrHTTPNotFound(`Route ${ctx.req.method}:${ctx.req.url} not found`)
}

/**
 * The rule, applied to every wildcard below: a path the application **declared** answers any client, and a
 * wildcard answers only a document request.
 *
 * That is what keeps a missing `/assets/app-HASH.js` a real 404 instead of HTML under a JavaScript content
 * type, and what keeps `curl` from being handed a page it cannot use.
 */
const clientRoute = (ctx: Context) => (isDocumentRequest(ctx) ? shellDocument(ctx) : notFound(ctx))

/**
 * Public pages. `/login` and `/forbidden` must stay anonymous: gating the sign-in page loops it through
 * itself, and gating the access-denied page turns a 403 into a redirect to a page that redirects.
 */
export const publicPages = newRouter()
  // `@caffeinejs/openapi` does not describe client routes — they are documents, not operations.
  .detail('http', { internal: true })
  .authorize({ allowAnonymous: true })
  .get('/', shellDocument)
  .get('/index.html', shellDocument)
  .get('/about', shellDocument)
  .get('/login', shellDocument)
  .get('/forbidden', shellDocument)
  // Anything the client routes that nothing above declared. Also the 404 page.
  .get('/*', clientRoute)

/**
 * Pages that need a session. An anonymous navigation here is redirected to `/login?returnUrl=…` by the cookie
 * scheme *before the page loads*, while an anonymous `fetch` gets 401 — one scheme, two right answers.
 *
 * Two routes per subtree: find-my-way does not match `/dashboard` against `/dashboard/*`.
 */
export const memberPages = newRouter()
  .detail('http', { internal: true })
  .authorize({})
  .get('/dashboard', shellDocument)
  .get('/dashboard/*', clientRoute)
  .get('/projects', shellDocument)
  .get('/projects/*', clientRoute)

/** Pages that need a role. A signed-in member navigating here lands on `/forbidden`; a fetch gets 403. */
export const adminPages = newRouter()
  .detail('http', { internal: true })
  .authorize({ roles: ['admin'] })
  .get('/admin', shellDocument)
  .get('/admin/*', clientRoute)

/**
 * The API owns its own misses.
 *
 * **One line, not one per controller.** find-my-way prefers the longer static prefix, so `/api/projects/brew`
 * still reaches the projects router and this only catches what nothing else did. Without it a browser typing
 * `/api/typo` would fall through to the client-route wildcard and be handed the application.
 */
export const apiMisses = newRouter('/api').get('/*', notFound)
