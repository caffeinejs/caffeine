import { extname, resolve } from 'node:path'

import { Value } from '@sinclair/typebox/value'

import type { CaffeineConfig } from './config.js'
import { caffeineConfigSchema } from './config_schema.js'

const CONFIG_BASENAME = '.caffeinerc'
const CONFIG_EXTENSIONS = ['.ts', '.js', '.mjs', '.json', '.yaml', '.yml'] as const
const MODULE_EXTENSIONS = new Set<string>(['.ts', '.js', '.mjs'])

/**
 * Reads the project config.
 *
 * Without `configPath` the extensions in {@link CONFIG_EXTENSIONS} are probed in order and the
 * first `.caffeinerc.<ext>` that exists wins. An extensionless `.caffeinerc` is never read.
 *
 * @param configPath - Explicit config file, resolved against `cwd`
 * @throws Error when no config is found, or when a JSON or YAML config does not match the schema
 */
export async function loadConfig(cwd: string, configPath?: string): Promise<CaffeineConfig> {
  if (configPath) {
    const path = resolve(cwd, configPath)
    if (!(await Bun.file(path).exists())) {
      throw new Error(`Cannot find caffeine config: "${configPath}"`)
    }
    return loadFile(path)
  }

  for (const extension of CONFIG_EXTENSIONS) {
    const path = resolve(cwd, CONFIG_BASENAME + extension)
    if (await Bun.file(path).exists()) {
      return loadFile(path)
    }
  }

  throw new Error(
    `Cannot find caffeine config: no ${CONFIG_BASENAME}.{${CONFIG_EXTENSIONS.map(e => e.slice(1)).join(',')}} found in "${cwd}"`,
  )
}

async function loadFile(path: string): Promise<CaffeineConfig> {
  const extension = extname(path)

  if (MODULE_EXTENSIONS.has(extension)) {
    const mod = (await import(path)) as { default?: CaffeineConfig } | CaffeineConfig
    return unwrapDefault(mod)
  }

  if (extension === '.json') {
    return validate(path, await Bun.file(path).json())
  }

  if (extension === '.yaml' || extension === '.yml') {
    return validate(path, Bun.YAML.parse(await Bun.file(path).text()))
  }

  throw new Error(`Cannot load caffeine config "${path}": unsupported extension "${extension}"`)
}

// Only the data formats are checked. A TypeScript or JavaScript config is already checked by tsc,
// and its moduleName function has no schema to match.
function validate(path: string, data: unknown): CaffeineConfig {
  if (Value.Check(caffeineConfigSchema, data)) {
    return data as CaffeineConfig
  }

  const [first] = [...Value.Errors(caffeineConfigSchema, data)]
  const detail = first ? `${first.path || '/'} ${first.message}` : 'it does not match the config schema'

  throw new Error(`Cannot parse caffeine config "${path}": ${detail}`)
}

function unwrapDefault(mod: { default?: CaffeineConfig } | CaffeineConfig): CaffeineConfig {
  if (mod && typeof mod === 'object' && 'default' in mod && mod.default) {
    return mod.default
  }
  return mod as CaffeineConfig
}
