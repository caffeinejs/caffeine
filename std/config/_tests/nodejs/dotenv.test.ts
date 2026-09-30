import { accessSync, constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadConfig } from '../../load.js'
import { loadEnvFiles } from '../../nodejs/dotenv.js'
import { passthroughConfigSchema } from '../../schema.js'
import { EnvConfigSource } from '../../sources/env_source.js'
import { JSONConfigSource } from '../../sources/json_source.js'
import type { ConfigDefinition, ConfigSource } from '../../types.js'

// Every variable these files set, and the one that names profiles. Unset before each test, so the machine running it
// decides nothing, and restored after, which also removes what `process.loadEnvFile` wrote.
const VARIABLES = [
  'CAFFEINE_PROFILES',
  'NODEJS_DOTENV_HOST',
  'NODEJS_DOTENV_PORT',
  'NODEJS_DOTENV_NAME',
  'NODEJS_DOTENV_DB__URL',
]

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'caffeine-dotenv-'))
  for (const name of VARIABLES) {
    vi.stubEnv(name, undefined)
  }
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

async function write(name: string, ...lines: string[]): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, `${lines.join('\n')}\n`)
  return path
}

// The prefix keeps every other variable of the process, the repository's own `.env` among them, out of the tree.
function environment(): EnvConfigSource {
  return new EnvConfigSource({ prefix: 'NODEJS_DOTENV_' })
}

function definition(sources: ConfigSource[]): ConfigDefinition {
  return {
    schema: passthroughConfigSchema,
    key: undefined,
    storeKey: undefined,
    sources,
    loadTimeoutMs: 30_000,
    dotenv: { loader: loadEnvFiles, path: dir },
  }
}

function thrown(run: () => void): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

describe('loadEnvFiles', () => {
  it('lets the file of a profile win over the base file, and a later profile an earlier one', async () => {
    await write('.env', 'NODEJS_DOTENV_HOST=base', 'NODEJS_DOTENV_PORT=1', 'NODEJS_DOTENV_NAME=base')
    await write('.env.dev', 'NODEJS_DOTENV_HOST=dev', 'NODEJS_DOTENV_PORT=2')
    await write('.env.prod', 'NODEJS_DOTENV_HOST=prod')

    const store = await loadConfig(definition([environment()]), { profiles: ['dev', 'prod'] })

    expect(store.current).toEqual({ host: 'prod', port: '2', name: 'base' })
  })

  // `process.loadEnvFile` sets what the base file holds as it reads it. Taken back before the profile's file loads, the
  // base still names the profile, and loses to it.
  it('takes the profiles the base file names, and lets the file of one win over the base', async () => {
    await write('.env', 'CAFFEINE_PROFILES=dev', 'NODEJS_DOTENV_HOST=base', 'NODEJS_DOTENV_PORT=1')
    await write('.env.dev', 'NODEJS_DOTENV_HOST=dev')

    const store = await loadConfig(definition([environment()]))

    expect(store.profiles).toEqual(['dev'])
    expect(store.current).toEqual({ host: 'dev', port: '1' })
  })

  it('never replaces a variable the environment already has', async () => {
    vi.stubEnv('NODEJS_DOTENV_HOST', 'from-environment')
    await write('.env', 'NODEJS_DOTENV_HOST=from-file', 'NODEJS_DOTENV_PORT=8080')

    const store = await loadConfig(definition([environment()]))

    expect(store.current).toEqual({ host: 'from-environment', port: '8080' })
  })

  it('skips a file that is not there', async () => {
    await write('.env.dev', 'NODEJS_DOTENV_HOST=dev')

    const store = await loadConfig(definition([environment()]), { profiles: ['dev', 'staging'] })

    expect(store.current).toEqual({ host: 'dev' })
  })

  // `process.loadEnvFile` reports a file it may not read as missing. Skipped as missing, an unreadable `.env.prod`
  // would leave the application on the base file's values.
  it('fails on a file that is there and cannot be read', async context => {
    const path = await write('.env.prod', 'NODEJS_DOTENV_HOST=prod')
    await chmod(path, 0o000)
    context.skip(
      thrown(() => accessSync(path, constants.R_OK)) === undefined,
      'this user reads a file whatever its mode',
    )

    expect(thrown(() => loadEnvFiles([path]))).toMatchObject({ code: 'EACCES' })
  })

  it('fails on a directory where a file should be', async () => {
    const path = join(dir, '.env.dev')
    await mkdir(path)

    expect(thrown(() => loadEnvFiles([path]))).toBeInstanceOf(Error)
  })

  // A path that names a file rather than the directory holding the files is a mistake to report, not a directory
  // with nothing in it.
  it('fails when the path names a file rather than a directory', async () => {
    const file = await write('settings', 'NODEJS_DOTENV_HOST=x')

    expect(thrown(() => loadEnvFiles([join(file, '.env')]))).toMatchObject({ code: 'ENOTDIR' })
  })

  it('fills in placeholders in what the files set', async () => {
    await write(
      '.env',
      'NODEJS_DOTENV_HOST=db.internal',
      'NODEJS_DOTENV_DB__URL=postgres://${env:NODEJS_DOTENV_HOST}/app',
    )

    const store = await loadConfig(definition([environment()]))

    expect(store.current).toEqual({ host: 'db.internal', db: { url: 'postgres://db.internal/app' } })
    expect(process.env.NODEJS_DOTENV_DB__URL).toBe('postgres://db.internal/app')
  })

  // The files load before any source, so a config file registered before the environment source still reads what
  // they set.
  it('hands file values to a file source registered before the environment source', async () => {
    await write('.env', 'NODEJS_DOTENV_HOST=db.internal')
    const json = await write('app.json', JSON.stringify({ db: { url: 'postgres://${env:NODEJS_DOTENV_HOST}/app' } }))

    const store = await loadConfig(definition([new JSONConfigSource(json), environment()]))

    expect(store.current).toEqual({ db: { url: 'postgres://db.internal/app' }, host: 'db.internal' })
  })
})
