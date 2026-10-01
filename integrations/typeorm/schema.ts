import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'
import type { DataSourceOptions } from 'typeorm'

/**
 * The schema of a data source's connection settings, satisfying TypeORM's `DataSourceOptions`. Hand the node to
 * `TypeORM((t, { config }) => t.config(...).dataSource({ type: 'postgres', entities }))`.
 *
 * The driver `type` is not here: it decides which of TypeORM's option shapes applies, so it is named in code
 * with the entities. Every other driver option is still `dataSource(...)`'s.
 */
export const TypeORMConfigSchema = $t.Object({
  url: $t.Optional($t.String()),
  host: $t.Optional($t.String()),
  port: $t.Optional($t.Integer({ minimum: 0, maximum: 65_535 })),
  username: $t.Optional($t.String()),
  password: $t.Optional($t.String()),
  database: $t.Optional($t.String()),
  schema: $t.Optional($t.String()),
  synchronize: $t.Optional($t.Boolean()),
  logging: $t.Optional($t.Boolean()),
})

type _Satisfies = SchemaSatisfies<DataSourceOptions, InferConfig<typeof TypeORMConfigSchema>>
