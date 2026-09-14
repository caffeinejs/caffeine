import { existsSync } from 'node:fs'
import { join, sep } from 'node:path'

import {
  collectRouteGroups,
  deriveServerOwnedPaths,
  ServerOwnedPaths,
  serverOwnedPaths,
  type RouteGroup,
} from '@caffeinejs/http'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import { ErrSPAIndexMissing } from './errors.js'
import { normalizePrefix, underPrefix, type SPASettings } from './spa.js'
import { SPAFallback } from './spa_fallback.js'
import type { StaticMount } from './static.js'

/** The slice of `reply` the per-file cache policy needs. */
interface HeaderCapableReply {
  header(key: string, value: string): unknown
}

/**
 * Registers each configured static mount with `@fastify/static`.
 *
 * `fastify-plugin`-wrapped, so `reply.sendFile` reaches every route group. `@fastify/static` throws if a
 * second registration tries to decorate it again — so only the first mount may decorate (unless a mount opts
 * out explicitly); the rest register with `decorateReply: false`.
 *
 * @param mounts - The resolved mounts, in registration order. The SPA's own mount, when there is one, is last
 * @param spa - The resolved SPA settings, or `undefined` when `.spa(...)` was never called
 */
export function staticPlugin(mounts: readonly StaticMount[], spa: SPASettings | undefined): FastifyPluginAsync {
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
      configureFallback(instance, spa, mounts)
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

function configureFallback(instance: FastifyInstance, spa: SPASettings, mounts: readonly StaticMount[]): void {
  const fallback = instance.$container.getOptional<SPAFallback>(SPAFallback)

  if (fallback === undefined) {
    return
  }

  const otherMountPrefixes = mounts
    .filter(mount => mount.root !== spa.root || mount.wildcard !== false)
    .map(mount => normalizePrefix(typeof mount.prefix === 'string' ? mount.prefix : '/'))

  fallback.configure(otherMountPrefixes, true)

  const routeGroups = collectRouteGroups(instance)
  instance.addHook('onReady', async () => {
    report(instance, spa, otherMountPrefixes, routeGroups())
  })
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
  routeGroups: readonly RouteGroup[],
): void {
  const derived = spa.derive
    ? deriveServerOwnedPaths(routeGroups, serverOwnedPaths(instance.$container.getManyOptional(ServerOwnedPaths)))
    : []
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
