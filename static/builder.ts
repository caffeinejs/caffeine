import { NotFoundFallback } from '@caffeinejs/http'
import { FeatureBuilder, kFeatureName, type BootstrapKit } from '@caffeinejs/std'
import { splitOptionBag, type ConfigSlice } from '@caffeinejs/std/config'

import { staticConfigSchema, type StaticConfigSlice } from './config.js'
import { ErrDuplicateSPAMount } from './errors.js'
import { StaticExtension } from './extension.js'
import { resolveSPASettings, type SPAOptions, type SPASettings } from './spa.js'
import { SPAFallback } from './spa_fallback.js'
import type { StaticMount } from './static.js'

/**
 * Configures static file serving over `@fastify/static`. Bound via
 * `.extend(StaticExt(), s => s.serve(dir, { prefix: '/static' }))`.
 *
 * The fluent methods are pure authoring; the lifecycle behind the symbol keys hands the assembled mounts to the
 * {@link StaticExtension} it binds. Each `.serve(...)` call adds one mount; multiple mounts serve multiple
 * directories (the {@link StaticExtension} handles `@fastify/static`'s single-decorate constraint).
 *
 * There is one read path. A builder method does not hold its value — it writes into the configuration tree in
 * the `CODE` band, and the feature reads the merged result. So `s.serve('public')` is a **default**: a
 * `static.mounts` in a config file replaces it. Settings live at `static.*`; {@link config} re-points them.
 *
 * `C` is the application config type, recovered from the builder `.extend(StaticExt(), …)` was reached through.
 */
export class StaticBuilder<C = unknown> extends FeatureBuilder<StaticConfigSlice, C> {
  readonly [kFeatureName] = 'static'

  protected readonly schema = staticConfigSchema

  #mounts: StaticMount[] = []
  #spa: (SPAOptions & { root: string }) | undefined
  #spaRoots: string[] = []
  #resolved?: ConfigSlice<ResolvedStatic>

  /**
   * Serves `root` as static files. `options` is the full `@fastify/static` options object minus `root`
   * (`prefix`, `index`, `wildcard`, `maxAge`, ...). Call again to serve additional directories.
   */
  serve(root: string, options?: Omit<StaticMount, 'root'>): this {
    this.#mounts.push({ root, ...options } as StaticMount)
    // Written straight into the bag: what the builder holds is a `@fastify/static` option bag, and only the
    // half of it that is not a function is what the slice declares.
    this.values.mounts = this.#mounts.map(dataOf)

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
   * .extend(StaticExt(), s => s.spa('site/dist'))
   * ```
   */
  spa(root: string, options?: SPAOptions): this {
    this.#spaRoots.push(root)

    // A code-level mistake, caught where it is made: two `.spa()` calls cannot both be right, and the answer
    // does not depend on anything configuration might say later.
    if (this.#spaRoots.length > 1) {
      throw new ErrDuplicateSPAMount(this.#spaRoots)
    }

    this.#spa = { ...options, root }
    this.values.spa = dataOf(this.#spa)

    return this
  }

  protected override beforeBootstrap(): void {
    // A callback cannot go through the tree at all — the validator cannot clone a function — so each
    // mount's callbacks are held here and re-attached by position once the slice publishes. A config
    // source that replaces `static.mounts` replaces the callbacks with it, which is the array rule being
    // consistent rather than an oversight.
    const callbacks = this.#mounts.map(callbacksOf)
    const spaCallbacks = this.#spa === undefined ? {} : callbacksOf(this.#spa)

    // Reaching `.spa(...)` is the activating act; configuration parameterizes the mount but never
    // switches it on, so that a config file cannot start serving a shell the application never asked for.
    const spaEnabled = this.#spa !== undefined

    this.#resolved = this.derive(published => resolveStatic(published, spaEnabled, callbacks, spaCallbacks))
  }

  protected bootstrap(kit: BootstrapKit): Promise<void> {
    const resolved = this.#resolved!
    const spa = this.#spa === undefined ? undefined : settingsOf(resolved.config)

    // Bound under its own key and registered with the application's extensions, so the adapter runs it as a
    // Fastify plugin — http no longer hardcodes it. The mounts and the SPA settings are handed to it directly:
    // the builder is holding them right here, and routing them through a container key only to read them back
    // at server setup adds a lookup and a key without a decision.
    kit.extensions.register(StaticExtension, new StaticExtension(resolved.config.mounts, spa))

    if (spa !== undefined) {
      kit.container.bind(SPAFallback, t => t.toValue(new SPAFallback(spa)).extends(NotFoundFallback))
    }

    return Promise.resolve()
  }
}

interface ResolvedStatic {
  mounts: StaticMount[]
  spa: SPASettings | undefined
}

function settingsOf(resolved: ResolvedStatic): SPASettings {
  if (resolved.spa === undefined) {
    throw new TypeError('The SPA mount is enabled but resolved to no settings')
  }
  return resolved.spa
}

/**
 * Folds the published slice into what the extension and the fallback actually run with.
 *
 * The SPA's own mount is derived here rather than pushed by `.spa(...)`, so a prefix or an index changed in
 * configuration reaches the `@fastify/static` registration too — appended after the plain mounts, which is the
 * order `.spa()` used to produce.
 */
function resolveStatic(
  published: StaticConfigSlice,
  spaEnabled: boolean,
  callbacks: readonly Record<string, unknown>[],
  spaCallbacks: Record<string, unknown>,
): ResolvedStatic {
  const mounts = (published.mounts ?? []).map((mount, i) => ({ ...mount, ...callbacks[i] }) as StaticMount)

  if (!spaEnabled || published.spa === undefined) {
    return { mounts, spa: undefined }
  }

  const { root, ...rest } = { ...published.spa, ...spaCallbacks } as StaticConfigSlice['spa'] & { root: string }
  const options = rest as SPAOptions
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

/** The half of an option bag a configuration tree can carry: everything that is not a function. */
function dataOf(options: object): Record<string, unknown> {
  return splitOptionBag(options).data
}

/** The other half — the callbacks, which are re-attached after the slice publishes. */
function callbacksOf(options: object): Record<string, unknown> {
  return splitOptionBag(options).callbacks
}
