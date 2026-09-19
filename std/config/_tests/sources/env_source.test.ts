import { describe, expect, it } from 'vitest'

import { $t } from '../../../schema/t.js'
import { loadConfig } from '../../load.js'
import { ArgsConfigSource } from '../../sources/args_source.js'
import { EnvConfigSource } from '../../sources/env_source.js'
import type { ConfigLayer, ConfigSchema, ConfigSource } from '../../types.js'

function load(options: ConstructorParameters<typeof EnvConfigSource>[0]): ConfigLayer {
  return new EnvConfigSource(options).load()[0]
}

function definition<T>(sources: ConfigSource[], schema: ConfigSchema<T>) {
  return { schema, key: undefined, storeKey: undefined, sources, loadTimeoutMs: 30_000 }
}

describe('EnvConfigSource', () => {
  it('folds underscores within a segment into camelCase', () => {
    expect(load({ env: { MY_VAR: 'hello' } }).data).toEqual({ myVar: 'hello' })
  })

  it('reaches a camelCase key, which is how features spell their settings', () => {
    expect(load({ env: { HEALTH__DRAIN_DELAY: '5s' } }).data).toEqual({ health: { drainDelay: '5s' } })
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

  // A list with a hole would surface later as a baffling complaint about index 0.
  it('refuses indices that are not a complete list, naming the source', () => {
    expect(() => load({ prefix: 'APP_', env: { APP_TAGS__1: 'z' } })).toThrow(
      expect.objectContaining({ code: 'ERR_CONFIG_ARRAY_INDICES', message: expect.stringContaining('"env:APP_"') }),
    )
  })

  it('refuses a path set both as a value and as a parent', () => {
    expect(() => load({ env: { TAGS: 'a,b', TAGS__0: 'c' } })).toThrow(
      expect.objectContaining({ code: 'ERR_CONFIG_KEY_CONFLICT' }),
    )
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
    expect(source.load()[0].data).toEqual({ lazy: 'read-late' })
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

  it('splits a delimited list for a field declared as one', async () => {
    const schema = $t.Object({ tags: $t.List($t.String()) })

    const store = await loadConfig(definition([new EnvConfigSource({ env: { TAGS: 'a,b,c' } })], schema))

    expect(store.current).toEqual({ tags: ['a', 'b', 'c'] })
  })
})
