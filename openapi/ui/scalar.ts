import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { solutions } from '@caffeinejs/http'
import { ErrOpenAPIConfiguration } from '../errors.js'

/**
 * Where the standalone browser build sits, relative to the directory holding the package's main entry.
 *
 * Located this way because the package's `exports` map publishes no subpath for it — not `./dist/browser/...`
 * and not even `./package.json` — so `require.resolve` cannot address the file directly. Resolving the main
 * entry is allowed, and the bundle's location relative to it is stable.
 */
const BUNDLE_CANDIDATES = ['browser/standalone.js', '../dist/browser/standalone.js', 'standalone.js']

/**
 * Reads Scalar's standalone browser bundle off disk.
 *
 * Served from the application's own origin rather than a CDN, which is the difference between documentation
 * that works on an air-gapped network under a strict CSP and documentation that silently renders a blank page
 * there. The bundle carries no dynamic imports, so the single file is the whole UI.
 *
 * The package is an optional peer dependency: an application that never calls `.docs(...)` does not pay for
 * it, and this is never called in that case.
 *
 * @throws ErrOpenAPIConfiguration when the peer dependency is not installed or its layout has moved.
 */
export function readScalarBundle(): string {
  const require = createRequire(import.meta.url)

  let entryDir: string
  try {
    entryDir = dirname(require.resolve('@scalar/api-reference'))
  } catch {
    throw notInstalled('"@scalar/api-reference" is not installed')
  }

  for (const candidate of BUNDLE_CANDIDATES) {
    try {
      return readFileSync(join(entryDir, candidate), 'utf8')
    } catch {
      continue
    }
  }

  throw notInstalled(
    `the standalone browser bundle was not found under "${entryDir}" — the package layout may have changed`,
  )
}

function notInstalled(reason: string): ErrOpenAPIConfiguration {
  return new ErrOpenAPIConfiguration(
    `Cannot serve the OpenAPI documentation UI: ${reason}`
    + solutions(
      'Install it with "npm install --save-dev @scalar/api-reference"',
      'Call .docs(false) on the OpenAPI builder to serve the document without a UI',
    ),
  )
}

/**
 * Configuration the page hands Scalar before anything the application sets.
 *
 * `proxyUrl` is the one that matters. Scalar otherwise resolves its own default, which routes the requests
 * "Try it" sends — URLs, headers and credentials included — through a third-party host. That is the opposite
 * of why the bundle is served from this origin in the first place, and it also breaks the common case for a
 * cookie-authenticated API: a request relayed by someone else's server carries none of the caller's cookies.
 * Empty means "send it straight from the browser".
 */
const DEFAULT_CONFIGURATION: Record<string, unknown> = { proxyUrl: '' }

/**
 * The page that mounts Scalar against the document.
 *
 * The bundle is referenced rather than inlined so the browser caches it across reloads under the immutable
 * cache header its route sets; the page itself stays a few hundred bytes.
 */
export function scalarPage(options: {
  title: string
  specURL: string
  assetURL: string
  configuration?: Record<string, unknown>
}): string {
  const configuration = JSON.stringify({ ...DEFAULT_CONFIGURATION, ...options.configuration })

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHTML(options.title)}</title>
  </head>
  <body>
    <div id="app"></div>
    <script id="api-reference" data-url="${escapeHTML(options.specURL)}" data-configuration="${escapeHTML(configuration)}"></script>
    <script src="${escapeHTML(options.assetURL)}"></script>
  </body>
</html>
`
}

function escapeHTML(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
