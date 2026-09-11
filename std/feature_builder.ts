import type { ConfigHandle } from './config/index.js'
import { kBootstrap, kFeatureName, type BootstrapKit, type Feature } from './feature.js'

/**
 * The callback an application writes to configure a feature, handed the builder and the resolved
 * configuration.
 *
 * `c` is the live configuration handle, so what the callback does with it decides what follows a refresh:
 * `b.port(c.app.server.port)` reads a number once, while `b.withConfig(c.app.server)` hands over a node whose
 * reads go through the current tree.
 *
 * ```ts
 * .extend(kafka((k, c) => k.brokers(c.app.kafka.brokers)))
 * ```
 */
export type FeatureConfigurer<B, C = unknown> = (builder: B, config: ConfigHandle<C>) => void

/**
 * Adds a configure callback to a builder the framework registered itself.
 *
 * `.extend(...)` hands a feature its callback at construction, but the built-in features — the server, the
 * shutdown policy, the probes — are registered before the application can name one, so `.server(...)` and its
 * siblings reach the already-registered builder through this. Symbol-keyed so it stays off the fluent
 * surface. Callbacks run in the order they were added.
 */
export const kAddConfigurer = Symbol('caffeine.feature.addConfigurer')

/**
 * The shape every feature builder takes: a fluent authoring surface that is also the {@link Feature}.
 *
 * A subclass names itself with {@link kFeatureName}, holds whatever its fluent methods set in ordinary
 * fields, and does its binding in {@link bootstrap}. The base owns one thing: running the application's
 * configure callbacks against the builder, with the resolved configuration, immediately before
 * {@link bootstrap}.
 *
 * A value set by a fluent method is **final**. Configuration reaches a feature because the callback wired it
 * — `s.port(c.app.server.port)` — and not through any path the builder opens on its own.
 *
 * `C` is the application configuration type, so a callback's second argument is typed against the tree the
 * application actually declared.
 */
export abstract class FeatureBuilder<C = unknown> implements Feature<C> {
  abstract get [kFeatureName](): string

  readonly #configurers: FeatureConfigurer<never, C>[] = []

  constructor(configure?: FeatureConfigurer<never, C>) {
    if (configure !== undefined) {
      this.#configurers.push(configure)
    }
  }

  [kAddConfigurer](configure: FeatureConfigurer<never, C>): void {
    this.#configurers.push(configure)
  }

  /**
   * Binds what this feature produces and registers its extensions. Runs after configuration has resolved and
   * before the container initializes, so binding is still open.
   */
  protected abstract bootstrap(kit: BootstrapKit<C>): void | Promise<void>

  [kBootstrap](kit: BootstrapKit<C>): void | Promise<void> {
    // Synchronous, and ahead of `bootstrap`: the application calls every feature's hook in order before
    // awaiting any of them, so each builder is fully authored before the first one does asynchronous work.
    for (const configure of this.#configurers) {
      configure(this as never, kit.config)
    }

    return this.bootstrap(kit)
  }
}
