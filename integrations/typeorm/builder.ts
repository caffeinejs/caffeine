import type { InjectionToken } from '@caffeinejs/di'
import { FeatureBuilder, type FeatureConfigureKit, type FeatureConfigurer, kFeatureName } from '@caffeinejs/std'
import { DataSource, type DataSourceOptions } from 'typeorm'

import { ErrMissingDataSourceOptions } from './errors.js'
import { dataSourceKey, DEFAULT_INSTANCE } from './keys.js'

/**
 * Builds one TypeORM DataSource and hands its lifecycle to the container.
 *
 * It restates none of TypeORM's configuration: {@link dataSource} takes `DataSourceOptions` in full, so every
 * driver option is available and entities travel in those options.
 */
export class TypeORMBuilder<C = unknown> extends FeatureBuilder<C> {
  get [kFeatureName](): string {
    return this.#name === DEFAULT_INSTANCE ? 'typeorm' : `typeorm:${this.#name}`
  }

  readonly #name: string
  #options: DataSourceOptions | undefined

  constructor(name: string = DEFAULT_INSTANCE, configure?: FeatureConfigurer<never, C>) {
    super(configure)

    this.#name = name
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
    const options = this.#options

    if (options === undefined) {
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
