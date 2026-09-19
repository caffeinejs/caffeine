import {
  resolveSPASettings,
  type SPAOptions,
  type SPASettings,
  type ResolvedStatic,
  type StaticMount,
} from './config.js'
import { ErrDuplicateSPAMount } from './errors.js'

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
 * Each `.serve(...)` call adds one mount; multiple mounts serve multiple directories (the plugin handles
 * `@fastify/static`'s single-decorate constraint). Reaching `.spa(...)` is the activating act — configuration
 * parameterizes the mount but never switches it on, so a config file cannot start serving a shell the
 * application never asked for.
 *
 * What a fluent method sets is final — there is no `.config(...)` to read a mount or a SPA setting from
 * the configuration tree.
 */
export class StaticBuilder {
  #mounts: StaticMount[] = []
  #spa: (SPAOptions & { root: string }) | undefined
  #spaRoots: string[] = []

  /**
   * Serves `root` as static files. `options` is the full `@fastify/static` options object minus `root`
   * (`prefix`, `index`, `wildcard`, `maxAge`, ...). Call again to serve additional directories.
   */
  serve(root: string, options?: Omit<StaticMount, 'root'>): this {
    this.#mounts.push({ root, ...options } as StaticMount)
    return this
  }

  /**
   * Serves `root` as a single-page application: its files, plus the shell for any client-side route.
   *
   * The three outcomes a same-origin SPA needs, which serving a directory cannot express on its own:
   *
   * - a real file is served as itself, with hashed assets cached indefinitely and the shell revalidated;
   * - a browser navigating to a client route (`/settings`) gets the shell with a `200`, not a `404`;
   * - anything else — an API miss, a missing asset — stays a `404` and renders through the error pipeline,
   *   so `/api/typo` answers with the same JSON body as a 404 a handler threw.
   *
   * Which paths the server owns is derived from the resolved routing, so a new controller is excluded without
   * being listed anywhere. `exclude`/`include` are there for what routing cannot know.
   *
   * The shell is served from the server's not-found handler, so a Fastify instance that already has one refuses
   * to start.
   *
   * ```ts
   * .with(staticFiles(s => s.spa('site/dist')))
   * ```
   */
  spa(root: string, options?: SPAOptions): this {
    this.#spaRoots.push(root)

    // A code-level mistake, caught where it is made: two `.spa()` calls cannot both be right.
    if (this.#spaRoots.length > 1) {
      throw new ErrDuplicateSPAMount(this.#spaRoots)
    }

    this.#spa = { ...options, root }

    return this
  }

  /**
   * Folds the mounts and the SPA options into what the plugin actually runs with.
   *
   * The SPA's own mount is derived here rather than pushed by `.spa(...)`, so it lands after the plain
   * mounts, the order `.spa()` used to produce.
   */
  [kBuild](): ResolvedStatic {
    const mounts = [...this.#mounts]

    if (this.#spa === undefined) {
      return { mounts, spa: undefined }
    }

    const { root, ...options } = this.#spa
    const settings = resolveSPASettings(root, options)

    // `wildcard: false` is load-bearing, not a tuning knob. `@fastify/static`'s default installs a catch-all
    // `GET /*`, which makes every unknown path a *matched* route that then serves its own 404 — so the
    // not-found handler never runs and there is nothing for the shell to fall back from. With it off the
    // plugin enumerates the real files at start-up and a miss falls through.
    mounts.push({
      ...options.static,
      root,
      prefix: `${settings.prefix}/`,
      index: [settings.index],
      wildcard: false,
      redirect: false,
    } as StaticMount)

    return { mounts, spa: settings }
  }
}

export type { SPASettings }
