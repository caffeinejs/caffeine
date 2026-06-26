import { resolve } from 'node:path'

export interface GenerateConfig {
  include: string[]
  exclude?: string[]
  output: string
  importExtension?: '.js' | '.ts' | ''
}

export interface CaffeineConfig {
  generate: GenerateConfig
}

export function defineConfig(config: CaffeineConfig): CaffeineConfig {
  return config
}

const CONFIG_CANDIDATES = [
  'caffeine.config.ts',
  'caffeine.config.js',
  'caffeine.config.mjs',
  'caffeine.config.json',
]

export async function loadConfig(cwd: string, configPath?: string): Promise<CaffeineConfig> {
  if (configPath) {
    return loadFile(resolve(cwd, configPath))
  }
  for (const candidate of CONFIG_CANDIDATES) {
    const path = resolve(cwd, candidate)
    try {
      return await loadFile(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw err
    }
  }
  throw new Error('Cannot find caffeine config: no caffeine.config.{ts,js,mjs,json} found in ' + cwd)
}

async function loadFile(path: string): Promise<CaffeineConfig> {
  if (path.endsWith('.json')) {
    return await Bun.file(path).json() as CaffeineConfig
  }
  const mod = await import(path) as { default?: CaffeineConfig } | CaffeineConfig
  return unwrapDefault(mod)
}

function unwrapDefault(mod: { default?: CaffeineConfig } | CaffeineConfig): CaffeineConfig {
  if (mod && typeof mod === 'object' && 'default' in mod && mod.default) {
    return mod.default
  }
  return mod as CaffeineConfig
}
