import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DotenvLoader, DotenvOptions } from '../dotenv.js'
import { loadConfig } from '../load.js'
import { passthroughConfigSchema } from '../schema.js'
import { EnvConfigSource } from '../sources/env_source.js'
import { JSONConfigSource } from '../sources/json_source.js'
import type { ConfigDefinition, ConfigSource } from '../types.js'

// Every variable these tests set. Unset before each test, so the machine running it decides nothing, and restored
// after, which also removes what the loaders wrote.
const VARIABLES = [
  'CAFFEINE_PROFILES',
  'DOTENV_TEST_HOST',
  'DOTENV_TEST_PORT',
  'DOTENV_TEST_NAME',
  'DOTENV_TEST_URL',
  'DOTENV_TEST_MIRROR',
  'DOTENV_TEST_GREETING',
  'DOTENV_TEST_LATE',
]

beforeEach(() => {
  for (const name of VARIABLES) {
    vi.stubEnv(name, undefined)
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/**
 * Stands in for a real loader: records the files it is handed, then sets what each would, in the order handed, never
 * replacing a variable already set, as `process.loadEnvFile` and dotenv do.
 */
function fakeLoader(files: Record<string, Record<string, string>> = {}) {
  const calls: string[][] = []
  const loader: DotenvLoader = filenames => {
    calls.push(filenames)
    for (const filename of filenames) {
      for (const [name, value] of Object.entries(files[basename(filename)] ?? {})) {
        if (process.env[name] === undefined) {
          vi.stubEnv(name, value)
        }
      }
    }
  }

  return { calls, loader }
}

// The prefix keeps every other variable of the process out of the tree.
function definition(
  dotenv: DotenvOptions,
  sources: ConfigSource[] = [new EnvConfigSource({ prefix: 'DOTENV_TEST_' })],
): ConfigDefinition {
  return {
    schema: passthroughConfigSchema,
    key: undefined,
    storeKey: undefined,
    sources,
    loadTimeoutMs: 30_000,
    dotenv,
  }
}

describe('dotenv files', () => {
  // The base file may name the profiles, so it is read before them, and alone.
  it('hands the loader the base file alone when no profile is active', async () => {
    const { calls, loader } = fakeLoader()

    await loadConfig(definition({ loader, path: 'config' }))

    expect(calls).toEqual([[join('config', '.env')]])
  })

  // Every mainstream loader lets the first file to set a variable win. Handed the profiles' files the last one first,
  // then the base again, a later profile wins over an earlier one and both over the base, with nothing to reverse.
  it('hands the loader every file once a profile is active, the most specific first', async () => {
    const { calls, loader } = fakeLoader()

    await loadConfig(definition({ loader, path: 'config' }), { profiles: ['dev', 'prod'] })

    expect(calls).toEqual([
      [join('config', '.env')],
      ['.env.prod', '.env.dev', '.env'].map(name => join('config', name)),
    ])
  })

  it('names the files after the base name it is given', async () => {
    const { calls, loader } = fakeLoader()

    await loadConfig(definition({ loader, path: 'config', baseName: 'app.env' }), { profiles: ['dev'] })

    expect(calls).toEqual([[join('config', 'app.env')], ['app.env.dev', 'app.env'].map(name => join('config', name))])
  })

  // What the base set is taken back before the profiles' files load: left in place, it would win over every one.
  it('lets the file of a profile win over the base file, and the environment over both', async () => {
    vi.stubEnv('DOTENV_TEST_NAME', 'environment')
    const { loader } = fakeLoader({
      '.env': { DOTENV_TEST_HOST: 'base', DOTENV_TEST_PORT: '1', DOTENV_TEST_NAME: 'base' },
      '.env.dev': { DOTENV_TEST_HOST: 'dev' },
    })

    const store = await loadConfig(definition({ loader, path: 'config' }), { profiles: ['dev'] })

    expect(store.current).toEqual({ host: 'dev', port: '1', name: 'environment' })
  })

  // The base file loads before the profiles are read, so what it names selects the profiles' dotenv files and every
  // source's overlays, as the environment would.
  it('takes the profiles the base file names with CAFFEINE_PROFILES', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'caffeine-dotenv-'))
    try {
      const json = join(dir, 'app.json')
      await writeFile(json, JSON.stringify({ region: 'base' }))
      await writeFile(join(dir, 'app-dev.json'), JSON.stringify({ region: 'dev' }))
      const { calls, loader } = fakeLoader({
        '.env': { CAFFEINE_PROFILES: 'dev', DOTENV_TEST_HOST: 'base' },
        '.env.dev': { DOTENV_TEST_HOST: 'dev' },
      })

      const store = await loadConfig(
        definition({ loader, path: 'config' }, [
          new JSONConfigSource(json),
          new EnvConfigSource({ prefix: 'DOTENV_TEST_' }),
        ]),
      )

      expect(store.profiles).toEqual(['dev'])
      expect(calls[1]).toEqual(['.env.dev', '.env'].map(name => join('config', name)))
      expect(store.current).toEqual({ region: 'dev', host: 'dev' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // The loader never replaces a variable already set, so the environment the application was started with wins.
  it('lets a CAFFEINE_PROFILES the environment holds win over the base file', async () => {
    vi.stubEnv('CAFFEINE_PROFILES', 'prod')
    const { loader } = fakeLoader({ '.env': { CAFFEINE_PROFILES: 'dev' } })

    const store = await loadConfig(definition({ loader, path: 'config' }))

    expect(store.profiles).toEqual(['prod'])
  })

  it('lets --caffeine.profiles win over the base file', async () => {
    const argv = [...process.argv]
    process.argv.push('--caffeine.profiles=prod')
    try {
      const { loader } = fakeLoader({ '.env': { CAFFEINE_PROFILES: 'dev' } })

      const store = await loadConfig(definition({ loader, path: 'config' }))

      expect(store.profiles).toEqual(['prod'])
    } finally {
      process.argv.splice(0, process.argv.length, ...argv)
    }
  })

  it('puts the profiles named in code before the ones the base file names', async () => {
    const { loader } = fakeLoader({ '.env': { CAFFEINE_PROFILES: 'dev' } })

    const store = await loadConfig(definition({ loader, path: 'config' }), { profiles: ['test'] })

    expect(store.profiles).toEqual(['test', 'dev'])
  })

  // The profiles are settled once the base file has loaded; the files they select name nothing.
  it('reads no profile from the file of a profile', async () => {
    const { calls, loader } = fakeLoader({
      '.env': { CAFFEINE_PROFILES: 'dev' },
      '.env.dev': { CAFFEINE_PROFILES: 'prod' },
    })

    const store = await loadConfig(definition({ loader, path: 'config' }))

    expect(store.profiles).toEqual(['dev'])
    expect(calls).toHaveLength(2)
  })

  it('waits for a loader that answers later before it reads the profiles or any source', async () => {
    const { loader: now } = fakeLoader({ '.env': { CAFFEINE_PROFILES: 'dev', DOTENV_TEST_LATE: 'from-file' } })
    const loader: DotenvLoader = async filenames => {
      await new Promise(resolve => setTimeout(resolve, 1))
      await now(filenames)
    }

    const store = await loadConfig(definition({ loader, path: 'config' }))

    expect(store.profiles).toEqual(['dev'])
    expect(store.current).toEqual({ late: 'from-file' })
  })

  // A file the application depends on and that cannot be loaded stops the start-up, rather than leaving the
  // application on its defaults.
  it('fails the load with what the loader threw, before any source loads', async () => {
    const failure = new Error('cannot read line 3')
    const loader: DotenvLoader = () => {
      throw failure
    }
    const load = vi.fn(() => [])

    await expect(loadConfig(definition({ loader, path: 'config' }, [{ name: 'spy', load }]))).rejects.toMatchObject({
      code: 'ERR_CONFIG_DOTENV',
      cause: failure,
    })
    expect(load).not.toHaveBeenCalled()
  })

  // The expansion is what every reader of the environment gets, not only the configuration.
  it('expands an entry that reads another, for every reader of the environment', async () => {
    const { loader } = fakeLoader({
      '.env': { DOTENV_TEST_PORT: '3000', DOTENV_TEST_GREETING: '${env:DOTENV_TEST_PORT} Hi' },
    })

    const store = await loadConfig(definition({ loader, path: 'config' }))

    expect(store.current).toEqual({ port: '3000', greeting: '3000 Hi' })
    expect(process.env.DOTENV_TEST_GREETING).toBe('3000 Hi')
  })

  // Expanded once every file has loaded: the base reads what only the file of a profile sets, through a chain.
  it('expands across the files, a chain first', async () => {
    const { loader } = fakeLoader({
      '.env': { DOTENV_TEST_HOST: 'db.internal', DOTENV_TEST_URL: 'postgres://${env:DOTENV_TEST_NAME}/app' },
      '.env.dev': { DOTENV_TEST_NAME: '${env:DOTENV_TEST_HOST}:5432' },
    })

    const store = await loadConfig(definition({ loader, path: 'config' }), { profiles: ['dev'] })

    expect(store.current).toMatchObject({ url: 'postgres://db.internal:5432/app' })
  })

  // A reference reads the value the process ends up with. What the environment set is data, never expanded.
  it("reads the environment's value where it overrides an entry, and never expands it", async () => {
    vi.stubEnv('DOTENV_TEST_PORT', '8080')
    vi.stubEnv('DOTENV_TEST_MIRROR', '${env:DOTENV_TEST_PORT}')
    const { loader } = fakeLoader({
      '.env': { DOTENV_TEST_PORT: '3000', DOTENV_TEST_GREETING: '${env:DOTENV_TEST_PORT} Hi' },
    })

    const store = await loadConfig(definition({ loader, path: 'config' }))

    expect(store.current).toEqual({ port: '8080', greeting: '8080 Hi', mirror: '${env:DOTENV_TEST_PORT}' })
  })

  it('falls back to the default a placeholder gives', async () => {
    const { loader } = fakeLoader({ '.env': { DOTENV_TEST_GREETING: 'Hello ${env:DOTENV_TEST_NAME:-World}' } })

    const store = await loadConfig(definition({ loader, path: 'config' }))

    expect(store.current).toEqual({ greeting: 'Hello World' })
  })

  // Expanded before the profiles are read, so the base file can name them through another of its variables.
  it('expands CAFFEINE_PROFILES before it names the profiles', async () => {
    const { loader } = fakeLoader({
      '.env': { DOTENV_TEST_NAME: 'dev', CAFFEINE_PROFILES: '${env:DOTENV_TEST_NAME}' },
    })

    const store = await loadConfig(definition({ loader, path: 'config' }))

    expect(store.profiles).toEqual(['dev'])
  })

  // The files load before any source, so there is no configuration yet for a placeholder to read.
  it('refuses a config placeholder, naming the variable and never its value', async () => {
    const { loader } = fakeLoader({ '.env': { DOTENV_TEST_URL: 'https://${config:host}/s3cret' } })

    const error = await loadConfig(definition({ loader, path: 'config' })).catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({ code: 'ERR_CONFIG_INTERPOLATION' })
    expect((error as Error).message).toContain('"DOTENV_TEST_URL"')
    expect((error as Error).message).not.toContain('s3cret')
  })

  // `${USER}` is how a loader that expands for itself writes a reference; this one refuses it.
  it.each<[label: string, entries: Record<string, string>]>([
    ['a variable set nowhere', { DOTENV_TEST_GREETING: '${env:DOTENV_TEST_NAME} Hi' }],
    [
      'references that loop',
      { DOTENV_TEST_HOST: '${env:DOTENV_TEST_NAME}', DOTENV_TEST_NAME: '${env:DOTENV_TEST_HOST}' },
    ],
    ['a malformed placeholder', { DOTENV_TEST_GREETING: 'Hello ${USER}' }],
  ])('fails the load on %s', async (_label, entries) => {
    const { loader } = fakeLoader({ '.env': entries })

    await expect(loadConfig(definition({ loader, path: 'config' }))).rejects.toMatchObject({
      code: 'ERR_CONFIG_INTERPOLATION',
    })
  })

  // Turning expansion off is what lets a loader that expands for itself work alongside.
  it('takes the files as written when interpolation is off', async () => {
    const { loader } = fakeLoader({ '.env': { DOTENV_TEST_GREETING: 'Hello ${USER}' } })

    const store = await loadConfig(definition({ loader, path: 'config', interpolate: false }))

    expect(store.current).toEqual({ greeting: 'Hello ${USER}' })
    expect(process.env.DOTENV_TEST_GREETING).toBe('Hello ${USER}')
  })
})
