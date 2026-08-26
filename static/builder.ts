import { kServiceConfigure, type Service } from '@caffeinejs/std'
import { NotFoundFallback, type ServiceKit } from '@caffeinejs/http'
import { ErrDuplicateSPAMount } from './errors.js'
import { StaticExtension } from './extension.js'
import { kSPASettings, kStaticMounts } from './keys.js'
import { resolveSPASettings, type SPAOptions, type SPASettings } from './spa.js'
import { SPAFallback } from './spa_fallback.js'
import type { StaticMount } from './static.js'

/**
 * Configures static file serving over `@fastify/static`. Bound via
 * `app.static(s => s.serve(dir, { prefix: '/static' }))`.
 *
 * A {@link Service}, like `ViewBuilder`/`ServerBuilder` — its {@link kServiceConfigure} binds the assembled
 * mounts into the container under {@link kStaticMounts}. Each `.serve(...)` call adds one mount; multiple
 * mounts serve multiple directories (the {@link StaticExtension} handles `@fastify/static`'s single-decorate
 * constraint).
 */
export class StaticBuilder implements Service {
  #mounts: StaticMount[] = []
  #spa: SPASettings | undefined
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
   * ```ts
   * app.static(s => s.spa('site/dist'))
   * ```
   */
  spa(root: string, options?: SPAOptions): this {
    this.#spaRoots.push(root)

    if (this.#spaRoots.length > 1) {
      throw new ErrDuplicateSPAMount(this.#spaRoots)
    }

    const settings = resolveSPASettings(root, options)
    this.#spa = settings

    // `wildcard: false` is load-bearing, not a tuning knob. `@fastify/static`'s default installs a catch-all
    // `GET /*`, which makes every unknown path a *matched* route that then serves its own 404 — so the
    // not-found handler never runs and there is nothing for the shell to fall back from. With it off the
    // plugin enumerates the real files at start-up and a miss falls through.
    this.#mounts.push({
      ...options?.static,
      root,
      prefix: `${settings.prefix}/`,
      index: [settings.index],
      wildcard: false,
      redirect: false,
    } as StaticMount)

    return this
  }

  [kServiceConfigure](kit: ServiceKit): Promise<void> {
    kit.container.bind(kStaticMounts).toValue(this.#mounts).internal()
    // Self-register the extension so the adapter discovers it via getManyOptional(ServerExtension)
    // and registers it as a Fastify plugin — http no longer hardcodes it.
    kit.container.bind(StaticExtension).toClass(StaticExtension).extends()

    if (this.#spa) {
      const fallback = new SPAFallback(this.#spa)

      kit.container.bind(kSPASettings).toValue(this.#spa).internal()
      kit.container.bind(SPAFallback).toValue(fallback).extends(NotFoundFallback)
    }

    return Promise.resolve()
  }
}
