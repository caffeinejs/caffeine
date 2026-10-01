import type { InjectionToken } from '@caffeinejs/di'
import { FeatureBuilder, type FeatureConfigureKit, type FeatureConfigurer, kFeatureName } from '@caffeinejs/std'
import { DataSource, type DataSourceOptions } from 'typeorm'

import { ErrMissingDataSourceOptions } from './errors.js'
import { dataSourceKey, DEFAULT_INSTANCE } from './keys.js'

/**
 * Builds one TypeORM DataSource and hands its lifecycle to the container.
 *
 * It restates none of TypeORM's configuration: {@link dataSource} takes `DataSourceOptions` in full, so every
 * driver option is available and entities travel in those options. {@link config} fills in what
 * {@link dataSource} left out, from the configuration tree.
 */
export class TypeORMBuilder<C = unknown> extends FeatureBuilder<C> {
  get [kFeatureName](): string {
    return this.#name === DEFAULT_INSTANCE ? 'typeorm' : `typeorm:${this.#name}`
  }

  readonly #name: string
  #options: DataSourceOptions | undefined
  #config: Partial<DataSourceOptions> | undefined

  constructor(name: string = DEFAULT_INSTANCE, configure?: FeatureConfigurer<never, C>) {
    super(configure)

    this.#name = name
  }

  /**
   * Reads connection settings from a node of the configuration tree, e.g. `config.app.db`.
   *
   * {@link dataSource} wins over what the node carries. The driver `type` and the entities are code: name them
   * with {@link dataSource}.
   */
  config(config: Partial<DataSourceOptions>): this {
    this.#config = config

    return this
  }

  /**
   * The options the DataSource is built from.
   *
   * @param options - TypeORM's own `DataSourceOptions`, entities included.
   */
  dataSource(options: DataSourceOptions): this {
    this.#options = options

    return this
  }

  protected override configure(kit: FeatureConfigureKit<C>): void {
    const options = { ...this.#config, ...definedOnly(this.#options) } as DataSourceOptions

    if (options.type === undefined) {
      throw new ErrMissingDataSourceOptions(this[kFeatureName])
    }

    // A named instance binds under its key alone: binding it under `DataSource` too would make that key
    // ambiguous the moment a second instance is installed.
    const key: InjectionToken<DataSource> = this.#name === DEFAULT_INSTANCE ? DataSource : dataSourceKey(this.#name)

    // Async, so `init()` awaits `initialize()` before any binding that injects a repository resolves. Disposal
    // runs in reverse creation order, so the DataSource closes after everything that used it.
    kit.container.bind(key, t =>
      t.toAsyncFactory(() => new DataSource(options).initialize()).preDestroy(ds => ds.destroy()),
    )
  }
}

/** The keys of `value` that hold something: an `undefined` written in code does not hide what configuration set. */
function definedOnly<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>
}
