import { resolve } from 'node:path'

import {
  normalizePrefix,
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
 * `@fastify/static`'s single-decorate constraint: the first plain mount decorates `reply.sendFile`). Reaching
 * `.spa(...)` is the activating act — configuration parameterizes the mount but never switches it on, so a
 * config file cannot start serving a shell the application never asked for.
 *
 * What a fluent method sets is final — there is no `.config(...)` to read a mount or a SPA setting from
 * the configuration tree. An application that wants them configured reads its own block in the callback.
 */
export class StaticBuilder {
  #mounts: StaticMount[] = []
  #spas: Array<SPAOptions & { root: string }> = []

  /**
   * Serves `root` as static files. `options` is the full `@fastify/static` options object minus `root`
   * (`prefix`, `index`, `wildcard`, `maxAge`, ...). Call again to serve additional directories. A relative
   * `root` is resolved against the working directory.
   */
  serve(root: string, options?: Omit<StaticMount, 'root'>): this {
    this.#mounts.push({ ...options, root: resolve(root) } as StaticMount)
    return this
  }

  /**
   * Serves `root` as a single-page application: its files, plus the shell for any client-side route.
   *
   * The three outcomes a same-origin SPA needs, which serving a directory cannot express on its own:
   *
   * - a real file is served as itself, with hashed assets cached indefinitely and the shell revalidated;
   * - a browser navigating to a client route (`/settings`) gets the shell with a `200`, not a `404`;
   * - anything else — an API miss, a missing asset, a `fetch()` to a typo — stays a `404` and renders through
   *   the error pipeline, so `/api/typo` answers with the same JSON body as a 404 a handler threw.
   *
   * The shell is an ordinary compiled route, `GET <prefix>/*`, so it is authorized like any other
   * (`authorize`, public by default), goes through the same error handling, and yields to every more specific
   * route the application registers. Which paths the server owns is derived from the compiled routing, so a new
   * controller is excluded without being listed anywhere; `exclude` / `include` are there for what routing
   * cannot know.
   *
   * Call it once per prefix to serve several shells from one origin, a public site at `/` and a gated
   * administration site at `/admin`, say; the longest prefix wins. A second shell at the same prefix, or a
   * route of the application's own at `<prefix>/*`, refuses to start rather than silently losing.
   *
   * ```ts
   * .with(staticFiles(s => s.spa('site/dist').spa('admin/dist', { prefix: '/admin', authorize: { roles: ['admin'] } })))
   * ```
   */
  spa(root: string, options: SPAOptions = {}): this {
    const prefix = normalizePrefix(options.prefix ?? '/')

    // A code-level mistake, caught where it is made: two shells at one prefix cannot both be right.
    if (this.#spas.some(spa => normalizePrefix(spa.prefix ?? '/') === prefix)) {
      throw new ErrDuplicateSPAMount(prefix || '/')
    }

    this.#spas.push({ ...options, root })

    return this
  }

  /** Folds the mounts and the shells into what the plugin actually runs with. */
  [kBuild](): ResolvedStatic {
    return {
      mounts: [...this.#mounts],
      spas: this.#spas.map(({ root, ...options }) => {
        const settings = resolveSPASettings(root, options)

        // The shell's files are served by `@fastify/static` with `wildcard: false`, so it enumerates the real
        // files at start-up and registers a route per file; its default catch-all `GET /*` would collide with
        // the shell's own route. The shell document itself is left to that route (`index: false`, and the
        // file ignored), so `GET /` and `GET /index.html` carry the same headers as `GET /settings`, and no
        // mount has to decorate `reply.sendFile` for the shell's sake.
        const mount = {
          ...options.static,
          root: settings.root,
          prefix: `${settings.prefix}/`,
          index: false,
          wildcard: false,
          redirect: false,
          decorateReply: false,
          globIgnore: [settings.index],
        } as StaticMount

        return { settings, mount }
      }),
    }
  }
}

export type { SPASettings }
