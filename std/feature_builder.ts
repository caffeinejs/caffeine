import {
  defineFeatureConfig,
  type ConfigDefinition,
  type ConfigHandle,
  type ConfigLocation,
  type ConfigSchema,
  type ConfigSlice,
  type FeatureConfigKey,
} from './config/index.js'
import { ErrCaffeine } from './error.js'
import {
  kBeforeBootstrap,
  kBootstrap,
  kFeatureName,
  type BeforeBootstrapKit,
  type BootstrapKit,
  type FeatureLifecycle,
} from './feature.js'

export class ErrFeatureNotDeclared extends ErrCaffeine {
  constructor(feature: string) {
    super(
      `Cannot read the configuration of "${feature}": the feature has not declared it yet`,
      'ERR_FEATURE_NOT_DECLARED',
      undefined,
      'Read the slice from "bootstrap", or from "beforeBootstrap" — never from a fluent authoring method',
    )
  }
}

/**
 * The shape every feature builder takes: a fluent authoring surface over one configuration slice.
 *
 * A subclass names its settings with {@link schema}, writes into them from its fluent methods with
 * {@link set}, and does its binding in {@link bootstrap}. Everything between — resolving where the settings
 * live, writing the two bands, registering the slice, publishing it under a key — happens here, so a feature
 * that wants nothing unusual writes none of it.
 *
 * There is one read path, and it is the same for every feature. A fluent method does not hold its value: it
 * writes into the configuration tree in the `CODE` band, and the feature reads the merged result. So a value
 * set in code is a **default** — a file, an environment variable or a command-line argument overrides it,
 * which is what lets one image ship with sensible values and still be redirected on deploy.
 *
 * Where those settings live is the application's choice and nothing else's. {@link config} records it; without
 * it the slice resolves **detached**, from the feature's own defaults and its fluent values alone. The feature
 * works either way; detached, nothing external reaches it and it adds no field to the application's
 * configuration object.
 *
 * `T` is the feature's configuration; `C` is the application configuration type, so the {@link config}
 * selector is typed against the tree the application actually declared.
 */
export abstract class FeatureBuilder<T, C = unknown> implements FeatureLifecycle {
  abstract readonly [kFeatureName]: string

  /**
   * The shape these settings take wherever the application puts them. Export it too — an application splices
   * it into its own schema rather than restating the fields.
   */
  protected abstract readonly schema: ConfigSchema<T>

  /**
   * Publishes the slice under a key, so code holding no builder can read it with `config(key)`. Omit it when
   * nothing outside this feature reads the settings.
   */
  protected readonly configKey?: FeatureConfigKey<T>

  /** `FRAMEWORK` band — the bottom of the chain. Everything overrides these. */
  protected readonly defaults?: Record<string, unknown>

  /**
   * The `CODE` band bag, written by the fluent methods. Prefer {@link set}, which types the value against the
   * field; reach for this directly only where what a builder holds is not shaped like what the slice declares.
   */
  protected readonly values: Record<string, unknown> = {}

  #selector: ((c: ConfigHandle<C>) => ConfigLocation<T>) | undefined
  #definition: ConfigDefinition | undefined
  #slice: ConfigSlice<T> | undefined

  /**
   * Places these settings in the configuration tree, e.g. `.config(c => c.app.thing)`.
   *
   * The selector names a location, not a value: it is evaluated once, while declaring, to record the path.
   * Both the reads and the values the fluent methods set follow it. The application's schema must describe
   * that location, though it need only describe the part it wants to control — the rest arrives from the
   * defaults, the builder, or the environment.
   */
  config(selector: (c: ConfigHandle<C>) => ConfigLocation<T>): this {
    this.#selector = selector
    return this
  }

  /** Writes one setting into the `CODE` band. `undefined` is skipped, never written as a null. */
  protected set<K extends keyof T & string>(key: K, value: T[K] | undefined): this {
    this.values[key] = value
    return this
  }

  /** What {@link set} last wrote, for a fluent method that merges rather than replaces. */
  protected get<K extends keyof T & string>(key: K): T[K] | undefined {
    return this.values[key] as T[K] | undefined
  }

  /**
   * The `CODE` band as it stands when the slice is registered. Defaults to whatever {@link set} wrote.
   *
   * Override it where a builder cannot write the band a key at a time — because it holds one options object
   * its setters mutate, or because what belongs in the band is a fold over several fields. Called once, while
   * declaring.
   */
  protected configValues(): Record<string, unknown> {
    return this.values
  }

  /**
   * Whether the declare step has run, so {@link slice} can be read.
   *
   * False for a builder driven directly rather than by an application — a unit test, or a hand-assembled
   * registration. Such a builder has no configuration system behind it at all and can only report what was
   * set in code.
   */
  protected get declared(): boolean {
    return this.#slice !== undefined
  }

  /**
   * This feature's slice. Available from {@link beforeBootstrap} onward; reading it from a fluent method
   * throws, because nothing has resolved where the settings live yet.
   */
  protected get slice(): ConfigSlice<T> {
    if (this.#slice === undefined) {
      throw new ErrFeatureNotDeclared(this[kFeatureName])
    }

    return this.#slice
  }

  /**
   * Configuration computed from the slice: the shape the feature actually runs on, folded over its defaults
   * and merged with whatever cannot travel through a configuration tree — a dispatcher, a handler, a class.
   *
   * Given a `key`, the **derived** slice is what that key answers with, which is what a feature whose readers
   * want the folded shape rather than the raw settings needs. Call it from {@link beforeBootstrap}.
   */
  protected derive<U>(compute: (config: T) => U, key?: FeatureConfigKey<U>): ConfigSlice<U> {
    const derived = this.slice.derive(compute)

    if (key !== undefined) {
      this.#definition!.publishFeature(key, derived)
    }

    return derived
  }

  /**
   * Declare-time work beyond registering the slice — a {@link derive}, most often. Runs once the slice
   * exists and before configuration resolves, so its values are not readable yet.
   */
  protected beforeBootstrap?(kit: BeforeBootstrapKit): void | Promise<void>

  /**
   * Binds what this feature produces and registers its extensions. Runs after configuration has resolved and
   * before the container initializes, so {@link slice}'s values are readable and binding is still open.
   */
  protected abstract bootstrap(kit: BootstrapKit): void | Promise<void>

  [kBeforeBootstrap](kit: BeforeBootstrapKit): void | Promise<void> {
    this.#definition = kit.config
    this.#slice = defineFeatureConfig<T>(kit.config, {
      selector: this.#selector as ((c: never) => unknown) | undefined,
      key: this.configKey,
      schema: this.schema,
      defaults: this.defaults,
      values: this.configValues(),
    })

    return this.beforeBootstrap?.(kit)
  }

  [kBootstrap](kit: BootstrapKit): void | Promise<void> {
    return this.bootstrap(kit)
  }
}
