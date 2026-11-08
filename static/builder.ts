import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { MountOptions, ResolvedStatic, StaticOptions, StaticRoot } from './config.js'

/**
 * Materializes a {@link StaticBuilder} into the {@link ResolvedStatic} it built.
 *
 * A symbol, not a public `.build()` method: the builder's only public surface is the fluent setters, so a
 * plain `.build()` alongside them would read as one more chainable option rather than the terminal call it is.
 */
export const kBuild = Symbol('caffeine.static.build')

/**
 * Configures static file serving, e.g. `staticFiles(s => s.serve('public'))`.
 *
 * Each `.serve(...)` call adds one mount. What a fluent method sets is final: the mounts {@link config} carries are
 * served only when no `.serve(...)` was called.
 */
export class StaticBuilder {
  #mounts: Array<ResolvedStatic['mounts'][number]> = []
  #config: Partial<StaticOptions> | undefined
  #allowProduction = false

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
   * Serves the files `root` lists in its `static.manifest.json`, which `buildStatic()` from
   * `@caffeinejs/static/build` writes, or, with `mode: 'scan'`, the files it holds at start-up.
   *
   * A relative `root` is resolved against the working directory, and a `file:` URL is converted to a path. Call
   * again to serve another directory, under its own prefix or with no path in common: two mounts answering one URL
   * fail start-up.
   *
   * @example
   * ```ts
   * s.serve('web/dist', { unrouted: ['index.html'], anonymous: true, immutable: ['assets/**'] })
   * ```
   */
  serve(root: StaticRoot, options: MountOptions = {}): this {
    this.#mounts.push({ root: resolveRoot(root), options: { ...options } })
    return this
  }

  /**
   * Allows a `mode: 'scan'` mount where `NODE_ENV` is `production`, which is refused otherwise. A warning is logged
   * at start-up. A production server should serve what `buildStatic()` wrote instead: scanning hashes every file at
   * start-up and serves no compressed variant.
   */
  allowProduction(): this {
    this.#allowProduction = true
    return this
  }

  /** Folds the mounts into what the plugin actually runs with. */
  [kBuild](): ResolvedStatic {
    const configured = this.#mounts.length > 0 || this.#config?.mounts === undefined ? undefined : this.#config.mounts

    return {
      mounts: configured?.map(({ root, ...options }) => ({ root: resolveRoot(root), options })) ?? [...this.#mounts],
      allowProduction: this.#allowProduction,
    }
  }
}

/** Makes a root absolute, the form every mount is compared and resolved in. */
export function resolveRoot(root: StaticRoot): string {
  return root instanceof URL ? fileURLToPath(root) : resolve(root)
}
