import type { HTTPSetupContext } from './setup_context.js'

/**
 * Produces what an adapter installs on its server from what the application resolved at start-up. Under the
 * Fastify adapter that is a plugin: see `HTTPPluginFactory`.
 *
 * What `.with(...)` takes when its argument is a function, and what `router.plugin(...)` and `@Use(...)` take.
 * Called once, after the container has initialized. Never deduplicated: two factories install two extensions.
 */
export type AdapterExtensionFactory<X, C = unknown> = (context: HTTPSetupContext<C>) => X | Promise<X>

/** One slot on the root server: an extension a factory produced, or a feature's server hook. */
export type AdapterExtensionEntry<I, X> =
  | { readonly kind: 'extension'; readonly extension: X }
  | { readonly kind: 'feature'; readonly name: string; readonly install: (instance: I) => void | Promise<void> }

/**
 * What an application hands its adapter to install.
 *
 * The root list is in the order the application wrote its `.with(...)` calls, and that order is the whole ordering
 * model: an adapter installs the entries one at a time, each finished before the next starts. What a router or a
 * controller asked for is kept apart, per scope, for the adapter to install in front of that scope's routes alone.
 */
export class AdapterExtensions<I, X> {
  readonly #root: AdapterExtensionEntry<I, X>[] = []
  readonly #scoped = new Map<object, X[]>()

  /** Adds an extension to the root list, or, given a router or a controller class, to that scope's own. */
  add(extension: X, scope?: object): void {
    if (scope === undefined) {
      this.#root.push({ kind: 'extension', extension })
      return
    }

    let scoped = this.#scoped.get(scope)
    if (scoped === undefined) {
      scoped = []
      this.#scoped.set(scope, scoped)
    }

    scoped.push(extension)
  }

  /** Adds a feature's server hook to the root list. */
  addFeature(name: string, install: (instance: I) => void | Promise<void>): void {
    this.#root.push({ kind: 'feature', name, install })
  }

  /** What the application installs on the root server, in the order it was written. */
  root(): readonly AdapterExtensionEntry<I, X>[] {
    return this.#root
  }

  /** What `scope`, a mounted router or a controller class, installs in front of its own routes. */
  of(scope: object): readonly X[] {
    return this.#scoped.get(scope) ?? []
  }
}
