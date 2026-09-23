import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Readable } from 'node:stream'

import {
  $p,
  collectRouteGroups,
  ErrHTTPNotFound,
  HTTPPluginFactory,
  isNavigation,
  kAuthenticationExempt,
  RouteBuilder,
  type Context,
  type HTTPPluginConfigurer,
} from '@caffeinejs/http'
import send from '@fastify/send'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import { deriveServerOwnedPaths, isServerOwned } from './_owned.js'
import { StaticBuilder, kBuild } from './builder.js'
import {
  normalizePrefix,
  underPrefix,
  type ResolvedSPA,
  type ResolvedStatic,
  type SPASettings,
  type StaticMount,
} from './config.js'
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
 *
 * A shell configured with `.spa(...)` is served from a compiled route the plugin adds with `$route`, so it is
 * authorized, error-handled and described like any route the application wrote.
 */
export function staticFiles<C = unknown>(configure?: StaticConfigurer<C>): HTTPPluginFactory<C> {
  return context => {
    const builder = new StaticBuilder()
    configure?.(builder, context)
    return staticPlugin(builder[kBuild]())
  }
}

function staticPlugin({ mounts, spas }: ResolvedStatic): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    for (let i = 0; i < mounts.length; i++) {
      const mount = mounts[i]

      // `@fastify/static` decorates `reply.sendFile` once per server, so the first plain mount does.
      await instance.register(fastifyStatic, {
        ...mount,
        decorateReply: i === 0 ? (mount.decorateReply ?? true) : false,
      })
    }

    const shells = spas.filter(spa => checkShell(instance, spa.settings))

    if (shells.length === 0) {
      return
    }

    // A shell's files are raw Fastify routes, so an application's fallback policy would gate them like any
    // route that declared nothing: a public shell whose scripts answer 401. The files of a shell anyone may
    // load are therefore exempt from authentication, marked as they register. `@fastify/static` forwards no
    // route config of its own, so the hook is the only way to reach them; it fires for exactly the mount
    // being registered, since a mount registers every file before its registration resolves.
    let exempt = false
    instance.addHook('onRoute', route => {
      if (exempt && route.config !== undefined) {
        route.config[kAuthenticationExempt] = true
      }
    })

    for (const { settings, mount } of shells) {
      exempt = settings.authorize.allowAnonymous === true
      await instance.register(fastifyStatic, {
        ...mount,
        ...(settings.cache !== false ? { setHeaders: cacheHeaders(settings) } : {}),
      })
      exempt = false
    }

    installShells(
      instance,
      shells.map(shell => shell.settings),
      mounts,
    )
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
 * Registers one compiled route per shell, `GET <prefix>/*`, through which every client-side route is served.
 *
 * A route rather than the server's not-found handler, so the shell is authorized like any route, so the
 * application's own not-found handler is untouched, and so several shells can share one origin: routing picks
 * the longest static prefix. A request the shell does not answer becomes an {@link ErrHTTPNotFound}, so it
 * renders through the error pipeline like a 404 a handler threw.
 */
function installShells(
  instance: FastifyInstance,
  shells: readonly SPASettings[],
  mounts: readonly StaticMount[],
): void {
  // A miss under a plain mount is a missing file, not a client route.
  const mountPrefixes = mounts
    .map(mount => normalizePrefix(typeof mount.prefix === 'string' ? mount.prefix : '/'))
    .filter(prefix => prefix !== '')

  const routeGroups = collectRouteGroups(instance)

  // Derived once every route has registered, which is before any request can reach a handler. Shared by the
  // shells, and mutated in place so the handlers closed over it see it.
  const owned: string[] = []
  const none: readonly string[] = []

  instance.addHook('onReady', async () => {
    if (shells.some(spa => spa.derive)) {
      // A shell's own group, or any other a feature registered on the application's behalf, owns no API prefix.
      owned.push(...deriveServerOwnedPaths(routeGroups().filter(group => group.detail?.http?.internal !== true)))
    }

    for (const spa of shells) {
      report(instance, spa, mountPrefixes, spa.derive ? owned : none, shells)
    }
  })

  for (const spa of shells) {
    const ownedFor = spa.derive ? owned : none
    // `/app/*` does not match `/app` itself, so a prefixed shell answers at its prefix too. The root shell's
    // `/*` matches `/`, and a route of its own there would collide with an application's `GET /`.
    const paths = spa.prefix === '' ? ['/*'] : [spa.prefix, `${spa.prefix}/*`]

    instance.$route(`spa:${spa.prefix || '/'}`, router => {
      router.detail('http', { internal: true })
      router.routes(
        paths.map(path =>
          new RouteBuilder()
            .method('GET')
            .path(path)
            .authorize(spa.authorize)
            .parameters($p.context())
            .handle((ctx: unknown) => serveShell(spa, ownedFor, mountPrefixes, ctx as Context)),
        ),
      )
    })
  }
}

/**
 * Answers one request that reached a shell's route: the shell document, or a 404 through the error pipeline.
 *
 * Sent with `@fastify/send`, the library under `@fastify/static`, so the shell gets the same `ETag`,
 * `Last-Modified`, conditional-request and `HEAD` handling as every file the mount serves, without depending
 * on which mount decorated `reply.sendFile`. `Cache-Control` is the shell's own.
 */
async function serveShell(
  spa: SPASettings,
  owned: readonly string[],
  mountPrefixes: readonly string[],
  ctx: Context,
): Promise<Readable> {
  const path = requestPath(ctx.req.url)

  if (path === undefined || !shouldServeShell(ctx, path, spa, owned, mountPrefixes)) {
    throw new ErrHTTPNotFound(`Route ${ctx.req.method}:${ctx.req.url} not found`)
  }

  const result = await send(ctx.req.raw as Readable, encodeURI(`/${spa.index}`), {
    root: spa.root,
    index: false,
    cacheControl: false,
    acceptRanges: false,
  })

  if (result.type !== 'file') {
    // The shell was there at start-up and is gone now: a deploy removed it under a running server.
    if (result.type === 'error' && result.statusCode !== 404) {
      throw result.metadata.error
    }

    throw new ErrHTTPNotFound(`Route ${ctx.req.method}:${ctx.req.url} not found`)
  }

  ctx.status(result.statusCode).headers(result.headers)

  if (spa.cache !== false) {
    ctx.header('cache-control', spa.cache.shell)
  }

  return result.stream
}

/**
 * The request path as the router matched it: decoded, without the query, duplicate slashes collapsed.
 *
 * Read from the URL rather than from `new URL(...)`, whose parser would take `//api//typo` for a host. A path
 * that cannot be decoded matched nothing the application registered, so it is not a client route either.
 */
function requestPath(url: string): string | undefined {
  const raw = url.split('?', 1)[0] ?? ''

  try {
    return decodeURIComponent(raw).replace(/\/{2,}/g, '/')
  } catch {
    return undefined
  }
}

/**
 * Whether a request that reached the shell's route gets the shell.
 *
 * The order of the checks is the design. A history fallback that answers every miss with `index.html` poisons
 * everything it touches: a missing hashed asset comes back as HTML served under a JavaScript content type,
 * and an API typo comes back as a document. So the shell is the *last* thing tried, and only for a request
 * that looks like a browser navigating to a path the server does not own and that names no file. The method
 * needs no check: the route is `GET`, and Fastify's `HEAD` twin is the only other way in.
 */
function shouldServeShell(
  ctx: Context,
  path: string,
  spa: SPASettings,
  owned: readonly string[],
  mountPrefixes: readonly string[],
): boolean {
  // `include` is the deliberate override, so it is checked before anything that could exclude the path.
  if (spa.include.some(prefix => underPrefix(path, prefix))) {
    return looksLikeDocument(ctx, path, spa)
  }

  if (isServerOwned(owned, path)) {
    return false
  }

  if (spa.exclude.some(prefix => underPrefix(path, prefix))) {
    return false
  }

  if (mountPrefixes.some(prefix => underPrefix(path, prefix))) {
    return false
  }

  return looksLikeDocument(ctx, path, spa)
}

/**
 * A request for a document: one naming no file, and — unless the shell answers everything — a navigation by
 * the framework's one definition of it. A request that says neither way is given the shell, so a test or a
 * tool sending no headers at all sees the page.
 */
function looksLikeDocument(ctx: Context, path: string, spa: SPASettings): boolean {
  if (namesAFile(path)) {
    return false
  }

  if (!spa.navigationOnly) {
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
 * States, once every route has registered, which paths will never receive the shell.
 *
 * The failure mode of a history fallback is silence — an API route starts answering with HTML and nothing
 * says so — and the decision is derived rather than written down, so it is printed where the answer is
 * otherwise invisible.
 */
function report(
  instance: FastifyInstance,
  spa: SPASettings,
  mountPrefixes: readonly string[],
  derived: readonly string[],
  shells: readonly SPASettings[],
): void {
  // Another shell nested under this one takes its own prefix by routing; it is listed so the picture is whole.
  const siblings = shells.filter(other => other !== spa && other.prefix !== '').map(other => other.prefix)
  const neverShell = [...new Set([...derived, ...spa.exclude, ...mountPrefixes, ...siblings])]
    .filter(prefix => underPrefix(prefix, spa.prefix) || spa.prefix === '')
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
}

/**
 * Per-file `Cache-Control` for the shell's files, which `maxAge` cannot express: it is per mount, and a SPA
 * needs its content-hashed assets cached indefinitely while everything else is revalidated within the hour.
 *
 * Applies only to files under the shell's root: `@fastify/static` runs the callback of whichever mount is
 * sending, and a file outside this root is not this shell's to describe.
 */
function cacheHeaders(spa: SPASettings): (reply: HeaderCapableReply, path: string) => void {
  const cache = spa.cache as Exclude<SPASettings['cache'], false>

  return (reply, path) => {
    const rel = relative(spa.root, path)

    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      return
    }

    // Compared against the path *within* the root, so `/assets` means the site's assets directory rather than
    // any directory of that name higher up the filesystem.
    const within = `/${rel.split(sep).join('/')}`

    reply.header(
      'cache-control',
      cache.immutable.some(prefix => underPrefix(within, prefix)) ? 'public, max-age=31536000, immutable' : cache.other,
    )
  }
}

export type { ResolvedSPA }
