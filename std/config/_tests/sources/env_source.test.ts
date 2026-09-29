import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { $t } from '../../../schema/t.js'
import { loadConfig } from '../../load.js'
import { passthroughConfigSchema } from '../../schema.js'
import { ArgsConfigSource } from '../../sources/args_source.js'
import { EnvConfigSource, type DotenvLoader } from '../../sources/env_source.js'
import { InlineConfigSource } from '../../sources/inline_source.js'
import type { ConfigLayer, ConfigLoadContext, ConfigSchema, ConfigSource } from '../../types.js'
import { RecordingLogger } from '../log.testkit.js'

function context(logger = new RecordingLogger(), profiles: readonly string[] = []): ConfigLoadContext {
  return { profiles, signal: new AbortController().signal, logger }
}

async function load(
  options: ConstructorParameters<typeof EnvConfigSource>[0],
  logger?: RecordingLogger,
): Promise<ConfigLayer> {
  return (await new EnvConfigSource(options).load(context(logger)))[0]
}

function definition<T>(sources: ConfigSource[], schema: ConfigSchema<T>) {
  return { schema, key: undefined, storeKey: undefined, sources, loadTimeoutMs: 30_000 }
}

describe('EnvConfigSource', () => {
  it('folds underscores within a segment into camelCase', async () => {
    expect((await load({ env: { MY_VAR: 'hello' } })).data).toEqual({ myVar: 'hello' })
  })

  it('reaches a camelCase key, which is how features spell their settings', async () => {
    expect((await load({ env: { SHUTDOWN__DRAIN_DELAY: '5s' } })).data).toEqual({ shutdown: { drainDelay: '5s' } })
  })

  it('leaves a single-word segment alone', async () => {
    expect((await load({ env: { SERVER__PORT: '8080' } })).data).toEqual({ server: { port: '8080' } })
  })

  it('reads only the variables that start with the prefix, and removes it', async () => {
    expect((await load({ prefix: 'APP_', env: { APP_HOST: 'localhost', OTHER: 'ignored' } })).data).toEqual({
      host: 'localhost',
    })
  })

  it('splits segments on the separator', async () => {
    expect((await load({ prefix: 'APP_', separator: '__', env: { APP_DB__HOST: 'localhost' } })).data).toEqual({
      db: { host: 'localhost' },
    })
  })

  it('builds a list from indexed variables', async () => {
    expect((await load({ env: { TAGS__0: 'a', TAGS__1: 'b' } })).data).toEqual({ tags: ['a', 'b'] })
  })

  it('keeps numeric keys that are not a list as the keys of a record', async () => {
    expect((await load({ env: { MESSAGES__404: 'Not found', MESSAGES__500: 'Oops' } })).data).toEqual({
      messages: { 404: 'Not found', 500: 'Oops' },
    })
  })

  // Without a prefix every variable of the process is read, other tools' among them. Two of them disagreeing about
  // a path cannot be allowed to stop the application from starting: the parent wins, and the other is reported.
  it('skips a variable whose path another one uses as a parent, and says so', async () => {
    const logger = new RecordingLogger()

    const layer = await load({ env: { OTEL__RESOURCE: 'x', OTEL__RESOURCE__ATTRIBUTES: 'a=b', PORT: '8080' } }, logger)

    expect(layer.data).toEqual({ otel: { resource: { attributes: 'a=b' } }, port: '8080' })
    expect(layer.origins?.has('otel.resource')).toBe(false)
    expect(logger.at('warn')).toEqual([
      expect.objectContaining({
        msg: 'config variable ignored',
        fields: { path: 'otel.resource', origin: 'env:OTEL__RESOURCE' },
      }),
    ])
  })

  // Shells set `_`, and macOS sets `__CF_USER_TEXT_ENCODING`: an unprefixed source reads them, and they must not
  // be able to stop an application from starting.
  it('skips a variable whose name maps to no path', async () => {
    expect(
      (await load({ env: { _: '/usr/bin/env', __CF_USER_TEXT_ENCODING: '0x1F6', __X__: 'x', PORT: '8080' } })).data,
    ).toEqual({
      port: '8080',
    })
  })

  it('keeps every value as text', async () => {
    expect(
      (await load({ env: { DEBUG: 'true', PORT: '8080', RATIO: '1.5', NAME: 'caffeine', EMPTY: '' } })).data,
    ).toEqual({
      debug: 'true',
      port: '8080',
      ratio: '1.5',
      name: 'caffeine',
      empty: '',
    })
  })

  it('records the variable each path came from', async () => {
    expect((await load({ env: { APP_PORT: '9000' } })).origins?.get('appPort')).toBe('env:APP_PORT')
  })

  it('is named env, or env and its prefix, unless told otherwise', () => {
    expect(new EnvConfigSource().name).toBe('env')
    expect(new EnvConfigSource({ prefix: 'APP_' }).name).toBe('env:APP_')
    expect(new EnvConfigSource({ prefix: 'APP_', name: 'environment' }).name).toBe('environment')
  })

  it('is static', () => {
    const source: ConfigSource = new EnvConfigSource({ env: {} })

    expect(source.live).toBeUndefined()
    expect(source.pollInterval).toBeUndefined()
    expect(source.watch).toBeUndefined()
  })

  // The host seam: a runtime whose environment is not `process.env` passes its own accessor.
  it('accepts a function, called at load time', async () => {
    let calls = 0
    const source = new EnvConfigSource({
      env: () => {
        calls++
        return { LAZY: 'read-late' }
      },
    })

    expect(calls).toBe(0)
    expect((await source.load(context()))[0].data).toEqual({ lazy: 'read-late' })
    expect(calls).toBe(1)
  })

  it('falls back to process.env when given nothing', async () => {
    process.env.CAFFEINE_ENV_FALLBACK_TEST = 'from-process'

    try {
      expect((await load({ prefix: 'CAFFEINE_ENV_FALLBACK_' })).data).toEqual({ test: 'from-process' })
    } finally {
      delete process.env.CAFFEINE_ENV_FALLBACK_TEST
    }
  })
})

describe('EnvConfigSource with dotenv files', () => {
  /**
   * Stands in for a real loader: records the files it is handed, then sets what they would, never overriding a
   * variable the environment already holds.
   */
  function fakeLoader(env: Record<string, string | undefined>, set: Record<string, string> = {}) {
    const calls: string[][] = []
    const loader: DotenvLoader = filenames => {
      calls.push(filenames)
      for (const [name, value] of Object.entries(set)) {
        env[name] ??= value
      }
    }

    return { calls, loader }
  }

  // Every mainstream loader lets the first file to set a variable win. In this order, a later profile wins over an
  // earlier one and both over the base file, with nothing to reverse.
  it('hands the loader the file of each active profile, the last one first, then the base file', async () => {
    const { calls, loader } = fakeLoader({})

    await new EnvConfigSource({ env: {}, dotenv: { loader, path: 'config' } }).load(
      context(new RecordingLogger(), ['dev', 'prod']),
    )

    expect(calls).toEqual([['.env.prod', '.env.dev', '.env'].map(name => join('config', name))])
  })

  it('hands the loader the base file alone when no profile is active', async () => {
    const { calls, loader } = fakeLoader({})

    await new EnvConfigSource({ env: {}, dotenv: { loader, path: 'config' } }).load(context())

    expect(calls).toEqual([[join('config', '.env')]])
  })

  it('names the files after the base name it is given', async () => {
    const { calls, loader } = fakeLoader({})

    await new EnvConfigSource({ env: {}, dotenv: { loader, path: 'config', baseName: 'app.env' } }).load(
      context(new RecordingLogger(), ['dev']),
    )

    expect(calls).toEqual([['app.env.dev', 'app.env'].map(name => join('config', name))])
  })

  it('reads the environment only once the loader has finished', async () => {
    const env: Record<string, string | undefined> = {}
    const loader: DotenvLoader = async () => {
      await new Promise(resolve => setTimeout(resolve, 1))
      env.LATE = 'from-file'
    }

    const layers = await new EnvConfigSource({ env, dotenv: { loader, path: 'config' } }).load(context())

    expect(layers[0].data).toEqual({ late: 'from-file' })
  })

  // The environment's values are data and the files' are the application's own text, whose placeholders are filled
  // in, so the two cannot share a layer. Below the environment's, the files' layer loses any path both reach.
  it("puts what the loader set in a layer of its own, below the environment's", async () => {
    const env: Record<string, string | undefined> = { APP_HOST: 'from-environment' }
    const { loader } = fakeLoader(env, { APP_HOST: 'from-file', APP_PORT: '8080' })

    const layers = await new EnvConfigSource({ prefix: 'APP_', env, dotenv: { loader, path: 'config' } }).load(
      context(),
    )

    expect(layers.map(({ name, data, interpolate }) => ({ name, data, interpolate }))).toEqual([
      { name: `dotenv:${join('config', '.env')}`, data: { port: '8080' }, interpolate: true },
      { name: 'env:APP_', data: { host: 'from-environment' }, interpolate: undefined },
    ])
    expect(layers[0].origins?.get('port')).toBe('env:APP_PORT')
  })

  // A file the application depends on and that cannot be loaded stops the start-up, rather than leaving the
  // application on its defaults.
  it('fails the load with what the loader threw', async () => {
    const failure = new Error('cannot read line 3')
    const loader: DotenvLoader = () => {
      throw failure
    }

    await expect(
      loadConfig(
        definition([new EnvConfigSource({ env: {}, dotenv: { loader, path: 'config' } })], passthroughConfigSchema),
      ),
    ).rejects.toMatchObject({ code: 'ERR_CONFIG_SOURCE', cause: failure })
  })

  // The profiles were chosen before any file loaded. Taken from a file, they would switch on the beans of a profile
  // whose overlays never loaded.
  it.each<[variable: string, prefix: string | undefined]>([
    ['CAFFEINE__PROFILES', undefined],
    ['CAFFEINE__PROFILES__0', undefined],
    ['APP_CAFFEINE__PROFILES', 'APP_'],
  ])('refuses %s from a dotenv file, never quoting its value', async (variable, prefix) => {
    const env: Record<string, string | undefined> = {}
    const { loader } = fakeLoader(env, { [variable]: 'canary-7f3a' })

    const error = await new EnvConfigSource({ prefix, env, dotenv: { loader, path: 'config' } })
      .load(context())
      .catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({ code: 'ERR_CONFIG_PROFILE' })
    expect((error as Error).message).toContain(`"${variable}"`)
    expect((error as Error).message).not.toContain('canary-7f3a')
  })

  // The environment named them before anything loaded, and the loader leaves a variable that is set alone.
  it('leaves the profiles the environment named alone', async () => {
    const env: Record<string, string | undefined> = { CAFFEINE__PROFILES: 'dev' }
    const { loader } = fakeLoader(env, { CAFFEINE__PROFILES: 'prod', PORT: '8080' })

    const layers = await new EnvConfigSource({ env, dotenv: { loader, path: 'config' } }).load(context())

    expect(layers.map(layer => layer.data)).toEqual([{ port: '8080' }, { caffeine: { profiles: 'dev' } }])
  })

  // A dotenv file is the application's own text, as a config file is. The environment's values are data: one that
  // looks like a placeholder is never read as one.
  it('fills in a placeholder the files set, and never one the environment set', async () => {
    const env: Record<string, string | undefined> = { APP_MIRROR: '${config:secret}' }
    const { loader } = fakeLoader(env, { APP_URL: 'https://${config:host}/app' })

    const store = await loadConfig(
      definition(
        [
          new InlineConfigSource({ host: 'example.test', secret: 's3cret' }),
          new EnvConfigSource({ prefix: 'APP_', env, dotenv: { loader, path: 'config' } }),
        ],
        passthroughConfigSchema,
      ),
    )

    expect(store.current).toMatchObject({ url: 'https://example.test/app', mirror: '${config:secret}' })
  })

  it('takes the files as written when interpolation is off', async () => {
    const env: Record<string, string | undefined> = {}
    const { loader } = fakeLoader(env, { APP_GREETING: 'Hello ${USER}' })

    const store = await loadConfig(
      definition(
        [new EnvConfigSource({ prefix: 'APP_', env, dotenv: { loader, path: 'config', interpolate: false } })],
        passthroughConfigSchema,
      ),
    )

    expect(store.current).toEqual({ greeting: 'Hello ${USER}' })
  })

  // A loader that expands values itself reads `${USER}` its own way; the configuration refuses it as a placeholder.
  // Turning interpolation off is what keeps the two from mixing.
  it('fails the load on a placeholder it cannot read, which a self-expanding loader can leave behind', async () => {
    const env: Record<string, string | undefined> = {}
    const { loader } = fakeLoader(env, { APP_GREETING: 'Hello ${USER}' })

    await expect(
      loadConfig(
        definition(
          [new EnvConfigSource({ prefix: 'APP_', env, dotenv: { loader, path: 'config' } })],
          passthroughConfigSchema,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'ERR_CONFIG_VALIDATION',
      issues: [expect.objectContaining({ path: 'greeting', code: 'ERR_CONFIG_INTERPOLATION' })],
    })
  })
})

// Defect 1: the provider used to guess a type from the text before the schema had a say, so a string field fed
// `VERSION=1` read back `'true'`, and `ZIP=01310` read back `'1310'`.
describe('text reaching the schema', () => {
  const schema = $t.Object({
    version: $t.String(),
    zip: $t.String(),
    build: $t.String(),
    flag: $t.String(),
    port: $t.Number(),
    verbose: $t.Boolean(),
  })

  it('reaches a string field exactly as it was written', async () => {
    const env = { VERSION: '1', ZIP: '01310', BUILD: '1e3', FLAG: 'on', PORT: '8080', VERBOSE: 'true' }

    const store = await loadConfig(definition([new EnvConfigSource({ env })], schema))

    expect(store.current).toEqual({ version: '1', zip: '01310', build: '1e3', flag: 'on', port: 8080, verbose: true })
  })

  // Moving a setting between the environment and the command line cannot change what it means.
  it('gives the same configuration from the command line as from the environment', async () => {
    const argv = ['--version=1', '--zip=01310', '--build=1e3', '--flag=on', '--port=8080', '--verbose']
    const env = { VERSION: '1', ZIP: '01310', BUILD: '1e3', FLAG: 'on', PORT: '8080', VERBOSE: 'true' }

    const fromArgs = await loadConfig(definition([new ArgsConfigSource({ argv })], schema))
    const fromEnv = await loadConfig(definition([new EnvConfigSource({ env })], schema))

    expect(fromArgs.current).toEqual(fromEnv.current)
  })

  // `TAGS__1` alone is a record's key rather than a list with a hole. A schema expecting a list still refuses it at
  // start-up, naming the list.
  it('fails validation, naming the list, when indices leave a hole in it', async () => {
    const schema = $t.Object({ tags: $t.Array($t.String()) })

    await expect(
      loadConfig(definition([new EnvConfigSource({ env: { TAGS__1: 'z' } })], schema)),
    ).rejects.toMatchObject({
      code: 'ERR_CONFIG_VALIDATION',
      issues: [expect.objectContaining({ path: expect.stringMatching(/^tags\b/) })],
    })
  })

  it('splits a delimited list for a field declared as one', async () => {
    const schema = $t.Object({ tags: $t.List($t.String()) })

    const store = await loadConfig(definition([new EnvConfigSource({ env: { TAGS: 'a,b,c' } })], schema))

    expect(store.current).toEqual({ tags: ['a', 'b', 'c'] })
  })
})
