import { token } from '@caffeinejs/di'
import type { DataSource } from 'typeorm'

/** The instance name a feature carries when the application does not name one. */
export const DEFAULT_INSTANCE = 'default'

/** The key the named instance's DataSource is bound to. The unnamed one binds under `DataSource` itself. */
export function dataSourceKey(name: string) {
  return token<DataSource>(Symbol.for(`@caffeinejs/typeorm:datasource:${name}`))
}
