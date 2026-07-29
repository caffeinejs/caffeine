import { type Module, Scopes } from '@caffeinejs/di'
import type { BootstrapOptions } from '../bootstrap.js'
import type { ConfigHandle } from '../config_accessor.js'
import type { ConfigSchema } from '../schema.js'
import type { ConfigProvider, ResolutionContext } from '../types.js'
import { ConfigShard } from './config_shard.js'

export const CONFIG_REFRESH_LABEL: unique symbol = Symbol('@caffeinejs/config:refresh-label')

export interface ConfigModuleOptions<T> {
  token: symbol | string
  schema: ConfigSchema<T>
  providers: ConfigProvider[]
  context?: ResolutionContext
  failFast?: boolean
}

export function ConfigModule<T>(options: ConfigModuleOptions<T>): Module {
  return async container => {
    const bootstrapOpts: BootstrapOptions<T> = {
      providers: options.providers,
      schema: options.schema,
      context: options.context,
      failFast: options.failFast,
    }

    const shard = await ConfigShard.bootstrap<T>(bootstrapOpts)
    const shardKey = Symbol('@caffeinejs/config:shard')

    container.bind<ConfigHandle<T>>(options.token as symbol).toValue(shard.handle)

    container
      .bind(shardKey)
      .toValue(shard)
      .lifetime(Scopes.REFRESH)
      .labels(CONFIG_REFRESH_LABEL as symbol)

    container.hooks.on('onDisposed', async () => {
      await shard.dispose()
    })
  }
}
