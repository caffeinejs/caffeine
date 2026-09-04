import type { Static } from '@sinclair/typebox'

import type { moduleGraphConfigSchema } from './config_schema.js'

/**
 * Settings of the module graph generator.
 *
 * {@link ModuleGraphConfig.moduleName} has no JSON or YAML equivalent — a config that uses it has
 * to be TypeScript or JavaScript.
 */
export type ModuleGraphConfig = Static<typeof moduleGraphConfigSchema> & {
  /** Maps a folder name to the `name` its generated module carries. */
  moduleName?: (name: string) => string
}

export interface CaffeineConfig {
  modules?: ModuleGraphConfig
}

export function defineConfig(config: CaffeineConfig): CaffeineConfig {
  return config
}
