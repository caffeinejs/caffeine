import { existsSync } from 'node:fs'
import { join, sep } from 'node:path'

import {
  collectRouteGroups,
  deriveServerOwnedPaths,
  ErrHTTPNotFound,
  HTTPPluginFactory,
  isServerOwned,
  ServerOwnedPaths,
  serverOwnedPaths,
  type HTTPPluginConfigurer,
} from '@caffeinejs/http'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

import { StaticBuilder, kBuild } from './builder.js'
import { normalizePrefix, underPrefix, type SPASettings, type ResolvedStatic, type StaticMount } from './config.js'
import { ErrSPAIndexMissing } from './errors.js'

/** The slice of `reply` the per-file cache policy needs. */
interface HeaderCapableReply {
  header(key: string, value: string): unknown
}

/** Authors static file serving through {@link StaticBuilder}. */
export type StaticConfigurer<C = unknown> = HTTPPluginConfigurer<StaticBuilder, C>

/**
 * Serves static files over `@fastify/static`, as an ordinary Fastify plugin factory:
 * `.with(staticFiles(s => s.serve(root)))`. http does not depend on this package.
 */
export function staticFiles<C = unknown>(configure?: StaticConfigurer<C>): HTTPPluginFactory<C> {
  return context => {
    const builder = new StaticBuilder()
    configure?.(builder, context)
    return staticPlugin(builder[kBuild]())
  }
}

function staticPlugin({ mounts, spa }: ResolvedStatic): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    const serveSPA = spa === undefined ? false : checkShell(instance, spa)

    for (let i = 0; i < mounts.length; i++) {
      const mount = mounts[i]
      const decorateReply = i === 0 ? (mount.decorateReply ?? true) : false
      const isSPAMount = spa !== undefined && mount.root === spa.root && mount.wildcard === false

      if (isSPAMount && !serveSPA) {
        continue
      }

      await instance.register(fastifyStatic, {
        ...mount,
        decorateReply,
        ...(isSPAMount && spa.cache !== false ? { setHeaders: cacheHeaders(spa) } : {}),
      })
    }

    if (spa !== undefined && serveSPA) {
      installShell(instance, spa, mounts)
    }
  }

  return fp(plugin, { name: '@caffeinejs/static' })
}

/**
 * Resolves whether the shell exists, honouring `onMissingIndex`.
 *
 * `'skip'` exists so one wiring serves both cases: the same application boots with the site built and
 * without it, instead of the caller probing for `index.html` and branching its own configuration.
 */
function checkShell(instance: FastifyInstance, spa: SPASettings): boolean {
  const indexPath = join(spa.root, spa.index)

  if (existsSync(indexPath)) {
    return true
  }

  if (spa.onMissingIndex === 'error') {
    throw new ErrSPAIndexMissing(indexPath)
  }

  instance.log.warn(`[static] SPA shell not found at "${indexPath}": serving the API only`)

  return false
}

/**
 * Takes the server's not-found handler to serve the shell for a client-side route.
 *
 * A request the shell does not answer becomes an {@link ErrHTTPNotFound}, so it renders through the error
 * pipeline like a 404 a handler threw.
 */
function installShell(instance: FastifyInstance, spa: SPASettings, mounts: readonly StaticMount[]): void {
  // A miss under another static mount is a missing file, not a client route.
  const otherMountPrefixes = mounts
    .filter(mount => mount.root !== spa.root || mount.wildcard !== false)
    .map(mount => normalizePrefix(typeof mount.prefix === 'string' ? mount.prefix : '/'))

  const routeGroups = collectRouteGroups(instance)

  // Derived once every route has registered, which is before any request can reach the handler.
  let owned: readonly string[] = []
  instance.addHook('onReady', async () => {
    owned = spa.derive
      ? deriveServerOwnedPaths(routeGroups(), serverOwnedPaths(instance.$container.getManyOptional(ServerOwnedPaths)))
      : []

    report(instance, spa, otherMountPrefixes, owned)
  })

  instance.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split('?')[0] ?? ''

    if (!shouldServeShell(req, path, spa, owned, otherMountPrefixes)) {
      throw new ErrHTTPNotFound(`Route ${req.method}:${req.url} not found`)
    }

    // Through `sendFile`, not a raw stream, so the shell gets the same ETag, range and cache-header handling
    // as every other file the mount serves.
    return reply.sendFile(spa.index, spa.root)
  })
}

/**
 * Whether a request that matched no route gets the shell.
 *
 * The order of the checks is the design. A history fallback that answers every 404 with `index.html` poisons
 * everything it touches: a missing hashed asset comes back as HTML served under a JavaScript content type,
 * and an API typo comes back as a document. So the shell is the *last* thing tried, and only for a request
 * that looks like a browser navigating to a path the server does not own and that names no file.
 */
function shouldServeShell(
  req: FastifyRequest,
  path: string,
  spa: SPASettings,
  owned: readonly string[],
  otherMountPrefixes: readonly string[],
): boolean {
  // A navigation is a GET. A POST to a client route is a mistake, and answering it with a document hides it.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false
  }

  if (!underPrefix(path, spa.prefix)) {
    return false
  }

  // `include` is the deliberate override, so it is checked before anything that could exclude the path.
  if (spa.include.some(prefix => underPrefix(path, prefix))) {
    return looksLikeDocument(req, path, spa)
  }

  if (isServerOwned(owned, path)) {
    return false
  }

  if (spa.exclude.some(prefix => underPrefix(path, prefix))) {
    return false
  }

  if (otherMountPrefixes.some(prefix => prefix !== '' && underPrefix(path, prefix))) {
    return false
  }

  return looksLikeDocument(req, path, spa)
}

function looksLikeDocument(req: FastifyRequest, path: string, spa: SPASettings): boolean {
  return !namesAFile(path) && (!spa.navigationOnly || isNavigation(req))
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
function isNavigation(req: FastifyRequest): boolean {
  const dest = req.headers['sec-fetch-dest']

  if (dest != null) {
    return dest === 'document'
  }

  const accept = req.headers.accept

  if (accept != null) {
    return accept.includes('text/html') || accept.includes('*/*')
  }

  return true
}

/**
 * States, once every route has registered, which paths will never receive the shell.
 *
 * The failure mode of a history fallback is silence — an API route starts answering with HTML and nothing
 * says so — and the decision is derived rather than written down, so it is printed where the answer is
 * otherwise invisible.
 */
function report(
  instance: FastifyInstance,
  spa: SPASettings,
  otherMountPrefixes: readonly string[],
  derived: readonly string[],
): void {
  const neverShell = [...new Set([...derived, ...spa.exclude, ...otherMountPrefixes.filter(p => p !== '')])]
    .filter(prefix => !spa.include.some(included => underPrefix(prefix, included)))
    .sort()

  instance.log.info(`[static] SPA shell ${spa.prefix || '/'} -> ${join(spa.root, spa.index)}`)
  instance.log.info(
    `[static]   never shell: ${neverShell.join(', ') || '(none)'} ` +
      `(derived: ${derived.length}, explicit: ${spa.exclude.length})`,
  )

  if (spa.cache !== false) {
    instance.log.info(`[static]   immutable: ${spa.cache.immutable.join(', ') || '(none)'}`)
  }

  for (const excluded of spa.exclude) {
    if (!derived.some(prefix => underPrefix(prefix, excluded) || underPrefix(excluded, prefix))) {
      instance.log.warn(`[static] SPA exclude "${excluded}" matches no registered route: it may be stale or misspelled`)
    }
  }
}

/**
 * Per-file `Cache-Control`, which `maxAge` cannot express: it is per mount, and a SPA needs the shell
 * revalidated on every navigation while its content-hashed assets are cached indefinitely.
 */
function cacheHeaders(spa: SPASettings): (reply: HeaderCapableReply, path: string) => void {
  const cache = spa.cache as Exclude<SPASettings['cache'], false>
  const indexPath = join(spa.root, spa.index)

  return (reply, path) => {
    if (path === indexPath) {
      reply.header('cache-control', cache.shell)
      return
    }

    // Compared against the path *within* the mount, so `/assets` means the site's assets directory rather
    // than any directory of that name higher up the filesystem.
    const relative = `/${path.startsWith(spa.root) ? path.slice(spa.root.length) : path}`
      .replace(/\/+/g, '/')
      .split(sep)
      .join('/')

    reply.header(
      'cache-control',
      cache.immutable.some(prefix => underPrefix(relative, prefix))
        ? 'public, max-age=31536000, immutable'
        : cache.other,
    )
  }
}
