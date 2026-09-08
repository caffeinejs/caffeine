import { existsSync } from 'node:fs'
import { join, sep } from 'node:path'

import {
  deriveServerOwnedPaths,
  ServerExtension,
  ServerOwnedPaths,
  serverOwnedPaths,
  type ServerExtensionContext,
} from '@caffeinejs/http'
import fastifyStatic from '@fastify/static'

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
 * `@fastify/static` decorates `reply.sendFile` and throws if a second registration tries to decorate it
 * again — so only the first mount may decorate (unless a mount opts out explicitly); the rest register with
 * `decorateReply: false`.
 */
export class StaticExtension extends ServerExtension {
  readonly name = 'static'

  /** The resolved mounts, in registration order. The SPA's own mount, when there is one, is last. */
  readonly mounts: readonly StaticMount[]

  /** The resolved SPA settings, or `undefined` when `.spa(...)` was never called. */
  readonly spa: SPASettings | undefined

  constructor(mounts: readonly StaticMount[], spa: SPASettings | undefined) {
    super()
    this.mounts = mounts
    this.spa = spa
  }

  configure = async (ctx: ServerExtensionContext): Promise<void> => {
    const mounts = this.mounts
    const spa = this.spa
    const serveSPA = spa === undefined ? false : this.#checkShell(ctx, spa)

    for (let i = 0; i < mounts.length; i++) {
      const mount = mounts[i]
      const decorateReply = i === 0 ? (mount.decorateReply ?? true) : false
      const isSPAMount = spa !== undefined && mount.root === spa.root && mount.wildcard === false

      if (isSPAMount && !serveSPA) {
        continue
      }

      await ctx.server.register(fastifyStatic, {
        ...mount,
        decorateReply,
        ...(isSPAMount && spa.cache !== false ? { setHeaders: cacheHeaders(spa) } : {}),
      })
    }

    if (spa !== undefined && serveSPA) {
      this.#configureFallback(ctx, spa, mounts)
    }
  }

  /**
   * Resolves whether the shell exists, honouring `onMissingIndex`.
   *
   * `'skip'` exists so one wiring serves both cases: the same application boots with the site built and
   * without it, instead of the caller probing for `index.html` and branching its own configuration.
   */
  #checkShell(ctx: ServerExtensionContext, spa: SPASettings): boolean {
    const indexPath = join(spa.root, spa.index)

    if (existsSync(indexPath)) {
      return true
    }

    if (spa.onMissingIndex === 'error') {
      throw new ErrSPAIndexMissing(indexPath)
    }

    ctx.server.log.warn(`[static] SPA shell not found at "${indexPath}": serving the API only`)

    return false
  }

  #configureFallback(ctx: ServerExtensionContext, spa: SPASettings, mounts: readonly StaticMount[]): void {
    const fallback = ctx.container.getOptional<SPAFallback>(SPAFallback)

    if (fallback === undefined) {
      return
    }

    const otherMountPrefixes = mounts
      .filter(mount => mount.root !== spa.root || mount.wildcard !== false)
      .map(mount => normalizePrefix(typeof mount.prefix === 'string' ? mount.prefix : '/'))

    fallback.configure(otherMountPrefixes, true)

    this.#report(ctx, spa, otherMountPrefixes)
  }

  /**
   * States, once, which paths will never receive the shell.
   *
   * The failure mode of a history fallback is silence — an API route starts answering with HTML and nothing
   * says so — and the decision is derived rather than written down, so it is printed where the answer is
   * otherwise invisible.
   */
  #report(ctx: ServerExtensionContext, spa: SPASettings, otherMountPrefixes: readonly string[]): void {
    const derived = spa.derive
      ? deriveServerOwnedPaths(ctx.routeGroups, serverOwnedPaths(ctx.container.getManyOptional(ServerOwnedPaths)))
      : []
    const neverShell = [...new Set([...derived, ...spa.exclude, ...otherMountPrefixes.filter(p => p !== '')])]
      .filter(prefix => !spa.include.some(included => underPrefix(prefix, included)))
      .sort()

    ctx.server.log.info(`[static] SPA shell ${spa.prefix || '/'} -> ${join(spa.root, spa.index)}`)
    ctx.server.log.info(
      `[static]   never shell: ${neverShell.join(', ') || '(none)'} ` +
        `(derived: ${derived.length}, explicit: ${spa.exclude.length})`,
    )

    if (spa.cache !== false) {
      ctx.server.log.info(`[static]   immutable: ${spa.cache.immutable.join(', ') || '(none)'}`)
    }

    for (const excluded of spa.exclude) {
      if (!derived.some(prefix => underPrefix(prefix, excluded) || underPrefix(excluded, prefix))) {
        ctx.server.log.warn(
          `[static] SPA exclude "${excluded}" matches no registered route: it may be stale or misspelled`,
        )
      }
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
