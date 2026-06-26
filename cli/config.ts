import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

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
    return loadFile(resolve(cwd, configPath), cwd)
  }
  for (const candidate of CONFIG_CANDIDATES) {
    const path = resolve(cwd, candidate)
    try {
      return await loadFile(path, cwd)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw err
    }
  }
  throw new Error('Cannot find caffeine config: no caffeine.config.{ts,js,mjs,json} found in ' + cwd)
}

async function loadFile(path: string, cwd: string): Promise<CaffeineConfig> {
  if (path.endsWith('.json')) {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as CaffeineConfig
  }
  if (path.endsWith('.ts')) {
    return loadTs(path, cwd)
  }
  const mod = await import(pathToFileURL(path).href) as { default?: CaffeineConfig } | CaffeineConfig
  return unwrapDefault(mod)
}

async function loadTs(path: string, cwd: string): Promise<CaffeineConfig> {
  const { spawnSync } = await import('node:child_process')

  const req = createRequire(resolve(cwd, 'package.json'))
  let tsxEsm: string
  try {
    tsxEsm = req.resolve('tsx/esm')
  } catch {
    throw new Error('Cannot load TypeScript config: tsx is required. Run: npm install -D tsx')
  }

  const href = pathToFileURL(path).href
  const script = `import(${JSON.stringify(href)}).then(m=>process.stdout.write(JSON.stringify(m.default??m)))`

  const result = spawnSync(process.execPath, ['--import', tsxEsm, '--eval', script], {
    encoding: 'utf8',
    cwd: dirname(path),
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error('Cannot load TypeScript config at ' + path + ':\n' + result.stderr)
  }

  return JSON.parse(result.stdout) as CaffeineConfig
}

function unwrapDefault(mod: { default?: CaffeineConfig } | CaffeineConfig): CaffeineConfig {
  if (mod && typeof mod === 'object' && 'default' in mod && mod.default) {
    return mod.default
  }
  return mod as CaffeineConfig
}
