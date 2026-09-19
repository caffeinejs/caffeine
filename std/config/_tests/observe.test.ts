import { describe, expect, it } from 'vitest'

import type { Logger } from '../../logger/logger.js'
import { $t } from '../../schema/t.js'
import { loadConfig } from '../load.js'
import { RecordingLogger } from '../log.testkit.js'
import { logConfigLoaded } from '../observe.js'
import { REDACTED } from '../redact.js'
import type { ConfigDefinition, ConfigSchema, ConfigSource } from '../types.js'

function definition<T>(sources: ConfigSource[], schema: ConfigSchema<T>): ConfigDefinition<T> {
  return { schema, key: undefined, storeKey: undefined, sources, loadTimeoutMs: 30_000 }
}

const schema = $t.Object({
  port: $t.Number(),
  token: $t.Secret($t.String()),
  tags: $t.Optional($t.Array($t.String())),
})

function live(data: Record<string, unknown>) {
  const state = { data }
  const source: ConfigSource = {
    name: 'remote',
    live: true,
    load: () => [{ name: 'remote', data: state.data as never }],
  }
  return { source, state }
}

describe('the events the store logs', () => {
  it('writes the first load report through the logger it is handed', async () => {
    const early = new RecordingLogger()
    const final = new RecordingLogger()
    const store = await loadConfig(
      definition(
        [
          { name: 'file', load: () => [{ name: 'file', data: { port: 1, token: 't' } }] },
          { name: 'empty', load: () => [] },
          { name: 'remote', optional: true, load: () => Promise.reject(new Error('unreachable')) },
        ],
        schema,
      ),
      { logger: early, profiles: ['eu'] },
    )

    logConfigLoaded(final, store)

    // Nothing reaches the logger configuration exists before the logger itself is configured.
    expect(early.records).toEqual([])
    expect(final.records.map(r => [r.level, r.msg])).toEqual([
      ['info', 'configuration loaded'],
      ['debug', 'config source loaded'],
      ['debug', 'config source skipped'],
      ['warn', 'config source failed'],
    ])
    expect(final.records[0].fields).toMatchObject({
      revision: 0,
      profiles: ['eu'],
      sources: ['file', 'empty', 'remote'],
      keys: 2,
    })
    expect(final.records[0].fields.ms).toEqual(expect.any(Number))
    expect(final.records[0].bindings).toEqual({ name: 'config' })
  })

  it('reports a reload with its trigger, sources and changed paths', async () => {
    const logger = new RecordingLogger()
    const { source, state } = live({ port: 1, token: 't' })
    const store = await loadConfig(definition([source], schema), { logger })

    state.data = { port: 2, token: 't', tags: ['a'] }
    await store.reload()

    expect(logger.at('info')).toEqual([
      expect.objectContaining({
        msg: 'configuration reloaded',
        fields: expect.objectContaining({
          revision: 1,
          trigger: 'manual',
          sources: ['remote'],
          changed: ['port', 'tags'],
          changedCount: 2,
        }),
      }),
    ])
  })

  it('caps the changed paths it lists at 20, and counts them all', async () => {
    const logger = new RecordingLogger()
    const many = (value: number) => Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, value]))
    const { source, state } = live(many(1))
    const store = await loadConfig(
      definition([source], { '~standard': { version: 1, vendor: 'pass', validate: (value: unknown) => ({ value }) } }),
      { logger },
    )

    state.data = many(2)
    await store.reload()

    const [record] = logger.at('info')
    expect(record.fields.changed).toHaveLength(20)
    expect(record.fields.changedCount).toBe(30)
  })

  it('reports a reload that changed nothing at debug level only', async () => {
    const logger = new RecordingLogger()
    const { source } = live({ port: 1, token: 't' })
    const store = await loadConfig(definition([source], schema), { logger })

    await store.reload()

    expect(logger.records.map(r => [r.level, r.msg])).toEqual([['debug', 'configuration unchanged']])
  })

  // A foreign validator may echo the value it rejected. A secret must not reach a log that way.
  it('lists the issues of a rejected reload, without the message of a secret one', async () => {
    const logger = new RecordingLogger()
    const { source, state } = live({ port: 1, token: 't' })
    const store = await loadConfig(definition([source], schema), { logger })

    // An object is not converted to a string, so the secret field fails as well.
    state.data = { port: 'nope', token: { leaked: 'super-secret' } }
    await store.reload()

    const [record] = logger.at('error')
    expect(record.msg).toBe('configuration reload rejected')
    expect(record.fields).toMatchObject({ trigger: 'manual', sources: ['remote'], revision: 0 })
    expect(record.fields.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'port', message: expect.not.stringContaining(REDACTED) }),
        { path: 'token', message: REDACTED },
      ]),
    )
  })

  it('reports a listener that throws', async () => {
    const logger = new RecordingLogger()
    const { source, state } = live({ port: 1, token: 't' })
    const store = await loadConfig(definition([source], schema), { logger })
    store.onChange(() => {
      throw new Error('bad reaction')
    })

    state.data = { port: 2, token: 't' }
    await store.reload()
    await store.settled()

    expect(logger.at('error')).toEqual([
      expect.objectContaining({
        msg: 'config change listener failed',
        fields: { err: expect.objectContaining({ message: 'bad reaction' }) },
      }),
    ])
  })

  it('says when it closed', async () => {
    const logger = new RecordingLogger()
    const store = await loadConfig(
      definition([{ name: 'file', load: () => [{ name: 'file', data: { port: 1, token: 't' } }] }], schema),
      {
        logger,
      },
    )

    await store.close()

    expect(logger.records.map(r => r.msg)).toEqual(['configuration closed'])
  })

  // The logger is configured from configuration, so it can change after the store exists.
  it('follows a logger that was replaced after start-up', async () => {
    const first = new RecordingLogger()
    const second = new RecordingLogger()
    let current: Logger = first
    const { source, state } = live({ port: 1, token: 't' })
    const store = await loadConfig(definition([source], schema), { logger: () => current })

    current = second
    state.data = { port: 2, token: 't' }
    await store.reload()

    expect(first.records).toEqual([])
    expect(second.at('info').map(r => r.msg)).toEqual(['configuration reloaded'])
  })

  it('never logs a configuration value', async () => {
    const logger = new RecordingLogger()
    const { source, state } = live({ port: 1, token: 'super-secret-token' })
    const store = await loadConfig(definition([source], schema), { logger })

    state.data = { port: 2, token: 'another-secret' }
    await store.reload()
    state.data = { port: 'bad', token: 'yet-another-secret' }
    await store.reload()
    logConfigLoaded(logger, store)

    const dump = JSON.stringify(logger.records)
    for (const secret of ['super-secret-token', 'another-secret', 'yet-another-secret']) {
      expect(dump).not.toContain(secret)
    }
  })
})
