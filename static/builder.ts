import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { MountOptions, ResolvedStatic, StaticMount, StaticRoot } from './config.js'

/**
 * Materializes a {@link StaticBuilder} into the {@link ResolvedStatic} it built.
 *
 * A symbol, not a public `.build()` method: the builder's only public surface is the fluent setters, so a
 * plain `.build()` alongside them would read as one more chainable option rather than the terminal call it is.
 */
export const kBuild = Symbol('caffeine.static.build')

/**
 * Configures static file serving over `@fastify/static`, e.g. `staticFiles(s => s.serve('public'))`.
 *
 * Each `.serve(...)` call adds one mount; multiple mounts serve multiple directories, and the plugin handles
 * `@fastify/static`'s single-decorate constraint.
 *
 * What a fluent method sets is final — there is no `.config(...)` to read a mount from the configuration
 * tree. An application that wants them configured reads its own block in the callback.
 */
export class StaticBuilder {
  #mounts: ResolvedStatic['mounts'] = []

  /**
   * Serves `root` as static files.
   *
   * `options` is the full `@fastify/static` options object minus `root` (`prefix`, `index`, `wildcard`,
   * `maxAge`, ...), passed through untouched. `mount` is what Caffeine adds around it. Call again to serve
   * additional directories. A relative `root` is resolved against the working directory, and a `file:` URL is
   * converted to a path.
   *
   * @example
   * ```ts
   * s.serve(DIST, { ...spaMount(), preCompressed: true }, { anonymous: true })
   * ```
   */
  serve(root: StaticRoot, options?: Omit<StaticMount, 'root'>, mount?: MountOptions): this {
    this.#mounts.push({
      mount: { ...options, root: resolveRoot(root) } as StaticMount,
      anonymous: mount?.anonymous === true,
    })

    return this
  }

  /** Folds the mounts into what the plugin actually runs with. */
  [kBuild](): ResolvedStatic {
    return { mounts: [...this.#mounts] }
  }
}

/** Makes every root absolute, which `@fastify/static` requires. */
function resolveRoot(root: StaticRoot): string | string[] {
  return Array.isArray(root) ? root.map(one => resolveOne(one)) : resolveOne(root as string | URL)
}

function resolveOne(root: string | URL): string {
  return root instanceof URL ? fileURLToPath(root) : resolve(root)
}
