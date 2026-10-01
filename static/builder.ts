import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { MountOptions, ResolvedStatic, StaticMount, StaticOptions, StaticRoot } from './config.js'

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
 * What a fluent method sets is final: the mounts {@link config} carries are served only when no `.serve(...)`
 * was called.
 */
export class StaticBuilder {
  #mounts: ResolvedStatic['mounts'] = []
  #config: Partial<StaticOptions> | undefined

  /**
   * Reads the mounts from a node of the configuration tree, e.g. `config.app.static`.
   *
   * Used only when no `.serve(...)` was called: mounts written in code replace the configured ones.
   */
  config(config: Partial<StaticOptions>): this {
    this.#config = config
    return this
  }

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
    if (this.#mounts.length > 0 || this.#config?.mounts === undefined) {
      return { mounts: [...this.#mounts] }
    }

    return {
      mounts: this.#config.mounts.map(({ root, anonymous, ...options }) => ({
        mount: { ...options, root: resolveRoot(root) } as StaticMount,
        anonymous: anonymous === true,
      })),
    }
  }
}

/** Makes every root absolute, which `@fastify/static` requires. */
function resolveRoot(root: StaticRoot): string | string[] {
  return Array.isArray(root) ? root.map(one => resolveOne(one)) : resolveOne(root as string | URL)
}

function resolveOne(root: string | URL): string {
  return root instanceof URL ? fileURLToPath(root) : resolve(root)
}
