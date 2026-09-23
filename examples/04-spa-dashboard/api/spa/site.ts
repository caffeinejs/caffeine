import { fileURLToPath } from 'node:url'

import { immutableAssets, spaMount, staticFiles } from '@caffeinejs/static'

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
 * `spaMount()` supplies `wildcard: false` (so a miss falls through to the client-route wildcard instead of the
 * mount answering its own 404, and so the mount's default catch-all does not collide with it), `index: false`
 * and a `globIgnore` that keeps `index.html` and the compressed siblings off the mount.
 *
 * `preCompressed` then serves `.br`/`.gz` from beside each file. It is filesystem-side rather than routing, so
 * it also applies to the `sendFile` in `pages.ts` — the shell is compressed without the route asking.
 *
 * `{ anonymous: true }` is what keeps this working under `requireAuthenticatedByDefault()`: the sign-in page
 * has to load its own scripts before anyone is signed in. It covers `favicon.svg`, `robots.txt`,
 * `sitemap.xml` and `manifest.webmanifest` too — each is its own route under `wildcard: false`, and listing
 * them by hand in the gate's `except` would drift the moment the build emits another one.
 */
export const site = staticFiles(s =>
  s.serve(SITE, { ...spaMount(), preCompressed: true, setHeaders: immutableAssets(SITE) }, { anonymous: true }),
)
