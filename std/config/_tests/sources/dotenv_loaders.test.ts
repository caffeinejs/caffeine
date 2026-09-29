import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import dotenv from 'dotenv'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DotenvLoader, DotenvOptions } from '../../dotenv.js'
import { loadConfig } from '../../load.js'
import { passthroughConfigSchema } from '../../schema.js'
import { EnvConfigSource } from '../../sources/env_source.js'
import type { ConfigDefinition } from '../../types.js'

// Every variable these files set, and the one that names profiles. Unset before each test, so the machine running it
// decides nothing, and restored after, which also removes what the loaders wrote.
const VARIABLES = [
  'CAFFEINE_PROFILES',
  'LOADERS_HOST',
  'LOADERS_PORT',
  'LOADERS_NAME',
  'LOADERS_DB_HOST',
  'LOADERS_DB_PORT',
  'LOADERS_DB_URL',
]

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'caffeine-dotenv-loaders-'))
  for (const name of VARIABLES) {
    vi.stubEnv(name, undefined)
  }
  // Set, it has dotenv decrypt a `.env.vault` instead of reading the files it is handed.
  vi.stubEnv('DOTENV_KEY', undefined)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

async function write(name: string, ...lines: string[]): Promise<void> {
  await writeFile(join(dir, name), `${lines.join('\n')}\n`)
}

// The prefix keeps every other variable of the process out of the tree.
function definition(dotenv: Omit<DotenvOptions, 'path'>): ConfigDefinition {
  return {
    schema: passthroughConfigSchema,
    key: undefined,
    storeKey: undefined,
    sources: [new EnvConfigSource({ prefix: 'LOADERS_' })],
    loadTimeoutMs: 30_000,
    dotenv: { ...dotenv, path: dir },
  }
}

describe('dotenv loaders', () => {
  // The configuration hands the files over in the order dotenv's own rule needs: nothing is reversed or overridden,
  // and the environment the application started with keeps the last word.
  it('takes dotenv as it is, the environment and the most specific file winning', async () => {
    await write('.env', 'LOADERS_HOST=base', 'LOADERS_PORT=1', 'LOADERS_NAME=base')
    await write('.env.dev', 'LOADERS_HOST=dev', 'LOADERS_PORT=2')
    vi.stubEnv('LOADERS_NAME', 'environment')
    const loader: DotenvLoader = files => {
      dotenv.config({ path: files, quiet: true })
    }

    const store = await loadConfig(definition({ loader }), { profiles: ['dev', 'staging'] })

    expect(store.current).toEqual({ host: 'dev', port: '2', name: 'environment' })
  })

  // Expansion can be the loader's own business. It sees every file at once, so a profile's file refers to what the
  // base file sets; with the configuration's interpolation off, the two never read the same text.
  it('leaves expansion to a loader that expands for itself, which sees every file at once', async () => {
    await write('.env', 'LOADERS_DB_HOST=localhost')
    await write('.env.dev', 'LOADERS_DB_URL=postgres://${LOADERS_DB_HOST}:${LOADERS_DB_PORT}/dev')
    vi.stubEnv('LOADERS_DB_PORT', '6543')
    const loader: DotenvLoader = files => {
      const { parsed = {} } = dotenv.config({ path: files, processEnv: {}, quiet: true })
      for (const [name, value] of Object.entries(parsed)) {
        process.env[name] ??= value.replace(/\$\{(\w+)\}/g, (_, ref: string) => process.env[ref] ?? parsed[ref] ?? '')
      }
    }

    const store = await loadConfig(definition({ loader, interpolate: false }), { profiles: ['dev'] })

    expect(store.current).toEqual({ dbHost: 'localhost', dbPort: '6543', dbUrl: 'postgres://localhost:6543/dev' })
  })
})
