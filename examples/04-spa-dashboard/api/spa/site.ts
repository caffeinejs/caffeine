import { fileURLToPath } from 'node:url'

import { staticFiles } from '@caffeinejs/static'

/**
 * The built front end. The one path that crosses from `api/` to `web/`.
 *
 * Built by `web/build.mjs`; `npm run build` runs it first, and the test suite's global setup builds it when it
 * is missing, so nothing here has to cope with an empty directory.
 */
export const SITE = fileURLToPath(new URL('../../web/dist', import.meta.url))

/**
 * Serves the bundle, and nothing else — the client routes are the application's own (`pages.ts`).
 *
 * The mount serves what `web/build.mjs` listed in `static.manifest.json`. A miss at the root falls through to the
 * client-route wildcard; a miss under `assets/` is the mount's own `404`. `unrouted` keeps `index.html` off the
 * router, so the shell is answered only by the document routes in `pages.ts`, through `sendFile`. The compressed
 * variants come from the manifest, so they apply to that `sendFile` too, and are never URLs of their own.
 *
 * `immutable` pins the hashed bundle for a year; everything else is revalidated on every use.
 *
 * `anonymous: true` is what keeps this working under `requireAuthenticatedByDefault()`: the sign-in page has to
 * load its own scripts before anyone is signed in. It covers `favicon.svg`, `robots.txt`, `sitemap.xml` and
 * `manifest.webmanifest` too, and lets a shared cache store them, since they are the same for every caller.
 */
export const site = staticFiles(s =>
  s.serve(SITE, { unrouted: ['index.html'], anonymous: true, immutable: ['assets/**'] }),
)
