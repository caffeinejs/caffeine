import { describe, expect, it } from 'vitest'

import { $t } from '../../../schema/t.js'
import { loadConfig } from '../../load.js'
import { ArgsConfigSource } from '../../sources/args_source.js'
import { EnvConfigSource } from '../../sources/env_source.js'
import type { ConfigLayer, ConfigLoadContext, ConfigSchema, ConfigSource } from '../../types.js'
import { RecordingLogger } from '../log.testkit.js'

function context(logger = new RecordingLogger()): ConfigLoadContext {
  return { profiles: [], signal: new AbortController().signal, logger }
}

function load(options: ConstructorParameters<typeof EnvConfigSource>[0], logger?: RecordingLogger): ConfigLayer {
  return new EnvConfigSource(options).load(context(logger))[0]
}

function definition<T>(sources: ConfigSource[], schema: ConfigSchema<T>) {
  return { schema, key: undefined, storeKey: undefined, sources, loadTimeoutMs: 30_000 }
}

describe('EnvConfigSource', () => {
  it('folds underscores within a segment into camelCase', () => {
    expect(load({ env: { MY_VAR: 'hello' } }).data).toEqual({ myVar: 'hello' })
  })

  it('reaches a camelCase key, which is how features spell their settings', () => {
    expect(load({ env: { SHUTDOWN__DRAIN_DELAY: '5s' } }).data).toEqual({ shutdown: { drainDelay: '5s' } })
  })

  it('leaves a single-word segment alone', () => {
    expect(load({ env: { SERVER__PORT: '8080' } }).data).toEqual({ server: { port: '8080' } })
  })

  it('reads only the variables that start with the prefix, and removes it', () => {
    expect(load({ prefix: 'APP_', env: { APP_HOST: 'localhost', OTHER: 'ignored' } }).data).toEqual({
      host: 'localhost',
    })
  })

  it('splits segments on the separator', () => {
    expect(load({ prefix: 'APP_', separator: '__', env: { APP_DB__HOST: 'localhost' } }).data).toEqual({
      db: { host: 'localhost' },
    })
  })

  it('takes a transformKey that replaces the folding', () => {
    expect(load({ env: { CACHE_TTL: '5s' }, transformKey: () => 'cache.TTL' }).data).toEqual({ cache: { TTL: '5s' } })
  })

  it('builds a list from indexed variables', () => {
    expect(load({ env: { TAGS__0: 'a', TAGS__1: 'b' } }).data).toEqual({ tags: ['a', 'b'] })
  })

  it('keeps numeric keys that are not a list as the keys of a record', () => {
    expect(load({ env: { MESSAGES__404: 'Not found', MESSAGES__500: 'Oops' } }).data).toEqual({
      messages: { 404: 'Not found', 500: 'Oops' },
    })
  })

  // Without a prefix every variable of the process is read, other tools' among them. Two of them disagreeing about
  // a path cannot be allowed to stop the application from starting: the parent wins, and the other is reported.
  it('skips a variable whose path another one uses as a parent, and says so', () => {
    const logger = new RecordingLogger()

    const layer = load({ env: { OTEL__RESOURCE: 'x', OTEL__RESOURCE__ATTRIBUTES: 'a=b', PORT: '8080' } }, logger)

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
  it('skips a variable whose name maps to no path', () => {
    expect(
      load({ env: { _: '/usr/bin/env', __CF_USER_TEXT_ENCODING: '0x1F6', __X__: 'x', PORT: '8080' } }).data,
    ).toEqual({
      port: '8080',
    })
  })

  it('keeps every value as text', () => {
    expect(load({ env: { DEBUG: 'true', PORT: '8080', RATIO: '1.5', NAME: 'caffeine', EMPTY: '' } }).data).toEqual({
      debug: 'true',
      port: '8080',
      ratio: '1.5',
      name: 'caffeine',
      empty: '',
    })
  })

  it('records the variable each path came from', () => {
    expect(load({ env: { APP_PORT: '9000' } }).origins?.get('appPort')).toBe('env:APP_PORT')
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
  it('accepts a function, called at load time', () => {
    let calls = 0
    const source = new EnvConfigSource({
      env: () => {
        calls++
        return { LAZY: 'read-late' }
      },
    })

    expect(calls).toBe(0)
    expect(source.load(context())[0].data).toEqual({ lazy: 'read-late' })
    expect(calls).toBe(1)
  })

  it('falls back to process.env when given nothing', () => {
    process.env.CAFFEINE_ENV_FALLBACK_TEST = 'from-process'

    try {
      expect(load({ prefix: 'CAFFEINE_ENV_FALLBACK_' }).data).toEqual({ test: 'from-process' })
    } finally {
      delete process.env.CAFFEINE_ENV_FALLBACK_TEST
    }
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
