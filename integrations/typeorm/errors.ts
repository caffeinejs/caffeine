import type { InjectionToken } from '@caffeinejs/di'
import type { EntityTarget, ObjectLiteral } from 'typeorm'

/** Base error for the TypeORM integration. */
export class ErrTypeORM extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'ErrTypeORM'
    this.code = code
  }
}

/** Thrown while the container compiles, when a repository injection names a key no DataSource is bound to. */
export class ErrNoDataSource extends ErrTypeORM {
  constructor(key: InjectionToken | undefined, target: EntityTarget<ObjectLiteral>) {
    super(
      `Cannot inject a repository for "${entityName(target)}": no DataSource is bound to the key "${keyName(key)}"` +
        '\n  - Install the feature with .with(typeorm(t => t.dataSource(options)))' +
        '\n  - Or provide one from a @Configuration class with @ProvidesAsync(DataSource)' +
        '\n  - If the repository is optional, wrap it with $i.optional($typeorm.repository(Entity))',
      'ERR_NO_DATA_SOURCE',
    )
    this.name = 'ErrNoDataSource'
  }
}

/** Thrown while the container compiles, when several DataSources answer to the key and none is primary. */
export class ErrNoUniqueDataSource extends ErrTypeORM {
  constructor(key: InjectionToken | undefined, target: EntityTarget<ObjectLiteral>) {
    super(
      `Cannot inject a repository for "${entityName(target)}": more than one DataSource is bound to the key ` +
        `"${keyName(key)}" and none is primary` +
        '\n  - Mark the one to prefer with @Primary' +
        '\n  - Or name each instance and select it, as $typeorm.repository(Entity, dataSourceKey("orders"))',
      'ERR_NO_UNIQUE_DATA_SOURCE',
    )
    this.name = 'ErrNoUniqueDataSource'
  }
}

/** Thrown when the feature configures without anyone having called `dataSource(...)` on its builder. */
export class ErrMissingDataSourceOptions extends ErrTypeORM {
  constructor(feature: string) {
    super(
      `Cannot configure feature "${feature}": no data source options were provided` +
        '\n  - Call .dataSource(options) in the configure callback, as typeorm(t => t.dataSource({ ... }))',
      'ERR_MISSING_DATA_SOURCE_OPTIONS',
    )
    this.name = 'ErrMissingDataSourceOptions'
  }
}

// Structural rather than an `instanceof EntitySchema` test, so reporting an error never pulls TypeORM in as
// a value.
function entityName(target: EntityTarget<ObjectLiteral>): string {
  if (typeof target === 'string') {
    return target
  }

  if (typeof target === 'function') {
    return target.name
  }

  return 'options' in target ? target.options.name : target.name
}

function keyName(key: InjectionToken | undefined): string {
  if (key === undefined) {
    return '(undefined)'
  }

  return typeof key === 'function' ? key.name : String(key)
}
