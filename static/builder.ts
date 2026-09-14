import { NotFoundFallback, registerPlugin } from '@caffeinejs/http'
import { FeatureBuilder, kFeatureName, type BootstrapKit, type FeatureConfigureKit } from '@caffeinejs/std'

import { ErrDuplicateSPAMount } from './errors.js'
import { resolveSPASettings, type SPAOptions, type SPASettings } from './spa.js'
import { SPAFallback } from './spa_fallback.js'
import type { ResolvedStatic, StaticMount } from './static.js'
import { staticPlugin } from './static_plugin.js'

/**
 * Configures static file serving over `@fastify/static`.
 *
 * Each `.serve(...)` call adds one mount; multiple mounts serve multiple directories (the plugin handles
 * `@fastify/static`'s single-decorate constraint). Reaching `.spa(...)` is the activating act — configuration
 * parameterizes the mount but never switches it on, so a config file cannot start serving a shell the
 * application never asked for.
 *
 * What a fluent method sets is final — there is no `.withConfig(...)` to read a mount or a SPA setting from
 * the configuration tree.
 */
export class StaticBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'static'

  #mounts: StaticMount[] = []
  #spa: (SPAOptions & { root: string }) | undefined
  #spaRoots: string[] = []
  #resolved: ResolvedStatic | undefined

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

  protected configure(kit: FeatureConfigureKit<C>): void {
    const resolved = this.#resolve()
    this.#resolved = resolved

    if (resolved.spa !== undefined) {
      kit.container.bind(SPAFallback, t => t.toValue(new SPAFallback(resolved.spa!)).extends(NotFoundFallback))
    }
  }

  protected bootstrap(kit: BootstrapKit<C>): void {
    const resolved = this.#resolved!

    // The mounts and the SPA settings are handed to the plugin directly: the builder is holding them right
    // here, and routing them through a container key only to read them back at server setup adds a lookup
    // and a key without a decision.
    registerPlugin(kit, staticPlugin(resolved.mounts, resolved.spa))
  }

  /**
   * Folds the mounts and the SPA options into what the plugin and the fallback actually run with.
   *
   * The SPA's own mount is derived here rather than pushed by `.spa(...)`, so it lands after the plain
   * mounts, the order `.spa()` used to produce.
   */
  #resolve(): ResolvedStatic {
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
