import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { $t } from '../../schema/t.js'
import { ErrConfig } from '../errors.js'
import { loadConfig } from '../load.js'
import { RecordingLogger } from '../log.testkit.js'
import { passthroughConfigSchema } from '../schema.js'
import type { ConfigDefinition, ConfigLoadContext, ConfigSchema, ConfigSource } from '../types.js'

function definition<T = unknown>(
  sources: ConfigSource[],
  schema: ConfigSchema<T> = passthroughConfigSchema as ConfigSchema<T>,
  loadTimeoutMs = 30_000,
): ConfigDefinition<T> {
  return { schema, key: undefined, storeKey: undefined, sources, loadTimeoutMs }
}

function source(name: string, data: Record<string, unknown>, extra: Partial<ConfigSource> = {}): ConfigSource {
  return { name, load: () => [{ name, data: data as never }], ...extra }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('loadConfig', () => {
  it('lets a later source win a conflicting value, and merges the rest', async () => {
    const store = await loadConfig(
      definition([
        source('defaults', { server: { host: 'localhost', port: 3000 } }),
        source('env', { server: { port: 8080 } }),
      ]),
    )

    expect(store.current).toEqual({ server: { host: 'localhost', port: 8080 } })
    expect(store.revision).toBe(0)
  })

  it('validates against the schema, defaults and conversion included', async () => {
    const schema = $t.Object({
      server: $t.Object({ host: $t.String({ default: '0.0.0.0' }), port: $t.Number() }, { default: {} }),
    })

    const store = await loadConfig(definition([source('env', { server: { port: '8080' } })], schema))

    expect(store.current).toEqual({ server: { host: '0.0.0.0', port: 8080 } })
  })

  it('freezes the snapshot and builds the live object over it', async () => {
    const store = await loadConfig(definition([source('a', { server: { port: 1 } })]))

    expect(Object.isFrozen(store.current)).toBe(true)
    expect(Object.isFrozen((store.current as { server: object }).server)).toBe(true)
    expect((store.live as { server: { port: number } }).server.port).toBe(1)
  })

  it('fails validation loudly at start-up', async () => {
    const schema = $t.Object({ port: $t.Number() })

    await expect(loadConfig(definition([source('a', { port: 'nope' })], schema))).rejects.toMatchObject({
      name: 'ErrConfigValidation',
      code: 'ERR_CONFIG_VALIDATION',
    })
  })

  it('rejects a root that validates to something other than an object', async () => {
    const schema = z.any().transform(() => 5)

    await expect(loadConfig(definition([source('a', {})], schema as never))).rejects.toMatchObject({
      name: 'ErrConfigValidation',
    })
  })

  it('refuses two sources with one name', async () => {
    await expect(loadConfig(definition([source('env', {}), source('env', {})]))).rejects.toMatchObject({
      code: 'ERR_CONFIG_DUPLICATE_SOURCE',
      message: expect.stringContaining('"env"'),
    })
  })

  it('refuses a poll interval that is not positive', async () => {
    await expect(loadConfig(definition([source('remote', {}, { pollInterval: 0 })]))).rejects.toMatchObject({
      code: 'ERR_CONFIG_SOURCE',
    })
  })

  it('fails the load when a source fails, and names the source', async () => {
    const broken = source(
      'remote',
      {},
      {
        load: () => {
          throw new Error('connection refused')
        },
      },
    )

    await expect(loadConfig(definition([broken]))).rejects.toMatchObject({
      name: 'ErrConfig',
      code: 'ERR_CONFIG_SOURCE',
      message: 'Cannot load config source "remote": connection refused',
      cause: expect.objectContaining({ message: 'connection refused' }),
    })
  })

  // A source that already explained itself is not buried under a generic message.
  it('passes a source own ErrConfig through as it is', async () => {
    const own = new ErrConfig('Cannot parse config file "x.json": oops', 'ERR_CONFIG_FILE_PARSE')
    const broken = source('file', {}, { load: () => Promise.reject(own) })

    await expect(loadConfig(definition([broken]))).rejects.toBe(own)
  })

  it('starts without an optional source that fails, and records why', async () => {
    const broken = source(
      'remote',
      {},
      {
        optional: true,
        load: () => Promise.reject(new Error('unreachable')),
      },
    )

    const store = await loadConfig(definition([source('defaults', { port: 1 }), broken]))
    const [, remote] = store.inspect().sources

    expect(store.current).toEqual({ port: 1 })
    expect(remote).toMatchObject({ name: 'remote', layers: [], consecutiveFailures: 1 })
    expect(remote.lastError).toMatchObject({ code: 'ERR_CONFIG_SOURCE' })
  })

  it('gives up on a source that does not answer within the load timeout', async () => {
    vi.useFakeTimers()
    const hung = source('remote', {}, { load: () => new Promise(() => undefined) })

    const loading = loadConfig(definition([hung], passthroughConfigSchema, 5_000))
    const outcome = expect(loading).rejects.toMatchObject({
      code: 'ERR_CONFIG_SOURCE_TIMEOUT',
      message: 'Cannot load config source "remote": no answer within 5000 ms',
    })
    await vi.advanceTimersByTimeAsync(5_000)

    await outcome
  })

  it('aborts the signal it handed a source that timed out', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const hung = source(
      'remote',
      {},
      {
        load: context => {
          signal = context.signal
          return new Promise(() => undefined)
        },
      },
    )

    const loading = loadConfig(definition([hung], passthroughConfigSchema, 1_000)).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(1_000)
    await loading

    expect(signal?.aborted).toBe(true)
  })

  it('tells each source the active profiles, deduplicated, and a logger of its own', async () => {
    let context: ConfigLoadContext | undefined
    const spy = source(
      'file',
      {},
      {
        load: c => {
          context = c
          return []
        },
      },
    )
    const logger = new RecordingLogger()

    await loadConfig(definition([spy]), { profiles: ['eu', ' dev ', 'eu', ''], logger })
    context!.logger.info('hello')

    expect(context?.profiles).toEqual(['eu', 'dev'])
    expect(logger.records[0].bindings).toEqual({ name: 'config', source: 'file' })
  })

  // The store freezes what it keeps. Freezing a source's own object would break a source that writes to it later.
  it('keeps a frozen copy, never the source own objects', async () => {
    const data = { server: { port: 1 }, tags: ['a'] }
    const store = await loadConfig(definition([source('inline', data)]))

    expect(Object.isFrozen(data)).toBe(false)
    data.server.port = 2
    data.tags.push('b')

    expect(store.current).toEqual({ server: { port: 1 }, tags: ['a'] })
  })

  it('drops __proto__, constructor and prototype from a layer, and says so', async () => {
    const logger = new RecordingLogger()
    const hostile = JSON.parse(
      '{"a":1,"__proto__":{"polluted":"yes"},"nested":{"constructor":{"x":1},"b":2}}',
    ) as Record<string, unknown>

    const store = await loadConfig(definition([source('file', hostile)]), { logger })

    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(store.current).toEqual({ a: 1, nested: { b: 2 } })
    expect(logger.at('warn').map(r => [r.msg, r.fields.path])).toEqual([
      ['config key ignored', '__proto__'],
      ['config key ignored', 'nested.constructor'],
    ])
  })

  it('refuses a layer that is not a name and an object', async () => {
    const odd = source('odd', {}, { load: () => [{ name: 'odd', data: ['not', 'an', 'object'] }] as never })

    await expect(loadConfig(definition([odd]))).rejects.toMatchObject({
      code: 'ERR_CONFIG_SOURCE',
      message: 'Cannot load config source "odd": every layer needs a string name and an object as data',
    })
  })

  it('arms no trigger when told not to start', async () => {
    vi.useFakeTimers()

    await loadConfig(definition([source('remote', {}, { pollInterval: 1_000 })]), { start: false })

    expect(vi.getTimerCount()).toBe(0)
  })
})
