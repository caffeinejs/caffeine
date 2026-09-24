import type { Feature, FeatureConfigurer } from '@caffeinejs/std'

import { TypeORMBuilder } from './builder.js'
import { DEFAULT_INSTANCE } from './keys.js'

export type TypeORMConfigurer<C = unknown> = FeatureConfigurer<TypeORMBuilder<C>, C>

/**
 * Installs a TypeORM DataSource, opened before `ready()` returns and closed on `close()`.
 *
 * The callback is required: a feature with no DataSource has nothing to do.
 *
 * @param instance - Names this DataSource, so an application can install several. The unnamed one is bound
 *   under TypeORM's `DataSource`; a named one under `dataSourceKey(instance)`.
 *
 * @throws {@link ErrMissingDataSourceOptions} at `ready()`, when the callback never calls `dataSource(...)`.
 */
export function typeorm<C = unknown>(configure: TypeORMConfigurer<C>): Feature<C>
export function typeorm<C = unknown>(instance: string, configure: TypeORMConfigurer<C>): Feature<C>
export function typeorm<C = unknown>(
  instanceOrConfigure: string | TypeORMConfigurer<C>,
  maybeConfigure?: TypeORMConfigurer<C>,
): Feature<C> {
  const named = typeof instanceOrConfigure === 'string'
  const instance = named ? instanceOrConfigure : DEFAULT_INSTANCE
  const configure = named ? maybeConfigure : instanceOrConfigure

  return new TypeORMBuilder<C>(instance, configure as never)
}
