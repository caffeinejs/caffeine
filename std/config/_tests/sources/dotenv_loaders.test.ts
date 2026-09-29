import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import dotenv from 'dotenv'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadConfig } from '../../load.js'
import { passthroughConfigSchema } from '../../schema.js'
import { EnvConfigSource, type DotenvLoader } from '../../sources/env_source.js'
import type { ConfigDefinition, ConfigSource } from '../../types.js'

// Each loader writes into a record the source reads through `env`, so no test touches the process environment.

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'caffeine-dotenv-loaders-'))
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

function definition(sources: ConfigSource[]): ConfigDefinition {
  return { schema: passthroughConfigSchema, key: undefined, storeKey: undefined, sources, loadTimeoutMs: 30_000 }
}

describe('dotenv loaders', () => {
  // The source hands the files over in the order dotenv's own rule needs: nothing is reversed or overridden, and
  // the environment the application started with keeps the last word.
  it('takes dotenv as it is, the environment and the most specific file winning', async () => {
    await write('.env', 'HOST=base', 'PORT=1', 'NAME=base')
    await write('.env.dev', 'HOST=dev', 'PORT=2')
    const env: Record<string, string | undefined> = { NAME: 'environment' }
    const loader: DotenvLoader = files => {
      dotenv.config({ path: files, processEnv: env, quiet: true })
    }

    const store = await loadConfig(definition([new EnvConfigSource({ env, dotenv: { loader, path: dir } })]), {
      profiles: ['dev', 'staging'],
    })

    expect(store.current).toEqual({ host: 'dev', port: '2', name: 'environment' })
  })

  // Expansion can be the loader's own business. It sees every file at once, so a profile's file refers to what the
  // base file sets; with the configuration's interpolation off, the two never read the same text.
  it('leaves expansion to a loader that expands for itself, which sees every file at once', async () => {
    await write('.env', 'DB_HOST=localhost')
    await write('.env.dev', 'DB_URL=postgres://${DB_HOST}:${DB_PORT}/dev')
    const env: Record<string, string | undefined> = { DB_PORT: '6543' }
    const loader: DotenvLoader = files => {
      const { parsed = {} } = dotenv.config({ path: files, processEnv: {}, quiet: true })
      for (const [name, value] of Object.entries(parsed)) {
        env[name] ??= value.replace(/\$\{(\w+)\}/g, (_, ref: string) => env[ref] ?? parsed[ref] ?? '')
      }
    }

    const store = await loadConfig(
      definition([new EnvConfigSource({ env, dotenv: { loader, path: dir, interpolate: false } })]),
      { profiles: ['dev'] },
    )

    expect(store.current).toEqual({ dbHost: 'localhost', dbPort: '6543', dbUrl: 'postgres://localhost:6543/dev' })
  })
})
