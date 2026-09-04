import { fileURLToPath } from 'node:url'

import { caffeineConfigSchema } from '../config_schema.js'

export const SCHEMA_PATH = fileURLToPath(new URL('../caffeinerc.schema.json', import.meta.url))

export function buildSchema(): Record<string, unknown> {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://caffeinejs.dev/schema/caffeinerc.json',
    title: 'Caffeine configuration',
    ...caffeineConfigSchema,
  }
}
