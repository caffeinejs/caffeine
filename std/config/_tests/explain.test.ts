import { describe, expect, it } from 'vitest'

import { $t } from '../../schema/t.js'
import { loadConfig } from '../load.js'
import { REDACTED } from '../redact.js'
import type { ConfigDefinition, ConfigLayer, ConfigSchema, ConfigSource } from '../types.js'

function definition<T>(sources: ConfigSource[], schema: ConfigSchema<T>): ConfigDefinition<T> {
  return { schema, key: undefined, storeKey: undefined, sources, loadTimeoutMs: 30_000 }
}

function source(name: string, ...layers: ConfigLayer[]): ConfigSource {
  return { name, load: () => layers }
}

const schema = $t.Object({
  server: $t.Object({ host: $t.String({ default: '0.0.0.0' }), port: $t.Number() }, { default: {} }),
  db: $t.Object({ url: $t.String(), password: $t.Secret($t.String()) }),
  map: $t.Optional($t.Record($t.String(), $t.String())),
})

async function loaded() {
  return loadConfig(
    definition(
      [
        source('file', {
          name: 'file:app.json',
          data: { server: { port: 3000 }, db: { url: 'u', password: 'from-file' } },
        }),
        source('env', {
          name: 'env',
          data: { server: { port: '8080' }, db: { password: 'from-env' } },
          origins: new Map([
            ['server.port', 'env:APP_SERVER__PORT'],
            ['db.password', 'env:APP_DB__PASSWORD'],
          ]),
        }),
      ],
      schema,
    ),
  )
}

describe('ConfigStore.explain', () => {
  it('lists every layer that defines a path, winner first, with its origin', async () => {
    const store = await loaded()

    expect(store.explain('server.port')).toEqual({
      path: 'server.port',
      value: 8080,
      layers: [
        { layer: 'env', origin: 'env:APP_SERVER__PORT', value: '8080' },
        { layer: 'file:app.json', origin: 'file:app.json', value: 3000 },
      ],
    })
  })

  it('lists no layer for a value a schema default supplied', async () => {
    const store = await loaded()

    expect(store.explain('server.host')).toEqual({ path: 'server.host', value: '0.0.0.0', layers: [] })
  })

  it('redacts a secret in the value and in every layer, and keeps the origin', async () => {
    const store = await loaded()

    expect(store.explain('db.password')).toEqual({
      path: 'db.password',
      value: REDACTED,
      layers: [
        { layer: 'env', origin: 'env:APP_DB__PASSWORD', value: REDACTED },
        { layer: 'file:app.json', origin: 'file:app.json', value: REDACTED },
      ],
    })
    expect(store.explain('db')).toMatchObject({ value: { url: 'u', password: REDACTED } })
  })

  // One schema object at two paths, the way an application reuses a feature's exported schema: the second password
  // is as hidden as the first.
  it('redacts a secret at every path a shared schema is used at', async () => {
    const credentials = $t.Object({ user: $t.String(), password: $t.Secret($t.String()) })
    const store = await loadConfig(
      definition(
        [
          source('file', {
            name: 'file:app.json',
            data: { primary: { user: 'a', password: 'first' }, replica: { user: 'b', password: 'second' } },
          }),
        ],
        $t.Object({ primary: credentials, replica: credentials }),
      ),
    )

    expect(store.explain('replica.password')).toEqual({
      path: 'replica.password',
      value: REDACTED,
      layers: [{ layer: 'file:app.json', origin: 'file:app.json', value: REDACTED }],
    })
    expect(JSON.stringify(store.inspect())).not.toContain('second')
  })

  it('reaches a key holding a literal dot through the array form', async () => {
    const store = await loadConfig(
      definition(
        [
          source('file', {
            name: 'file',
            data: { server: { port: 1 }, db: { url: 'u', password: 'p' }, map: { 'a.b': 'x' } },
          }),
        ],
        schema,
      ),
    )

    expect(store.explain(['map', 'a.b'])).toMatchObject({ path: 'map.a.b', value: 'x' })
    expect(store.explain('map.a.b').value).toBeUndefined()
  })

  it('explains a path nothing defines', async () => {
    const store = await loaded()

    expect(store.explain('nowhere.at.all')).toEqual({ path: 'nowhere.at.all', value: undefined, layers: [] })
  })
})

describe('ConfigStore.inspect', () => {
  it('reports each source, its trigger, its layers and its health', async () => {
    const store = await loadConfig(
      definition(
        [
          source('file', { name: 'file:app.json', data: { db: { url: 'u', password: 'p' } } }),
          { name: 'remote', live: true, load: () => [{ name: 'remote', data: { server: { port: 1 } } }] },
          { name: 'polled', pollInterval: 60_000, load: () => [] },
        ],
        schema,
      ),
      { start: false },
    )

    const inspection = store.inspect()

    expect(inspection).toMatchObject({ revision: 0, profiles: [] })
    expect(inspection.swappedAt).toBeGreaterThan(0)
    expect(inspection.sources).toEqual([
      expect.objectContaining({
        name: 'file',
        trigger: 'static',
        layers: ['file:app.json'],
        keys: 2,
        consecutiveFailures: 0,
      }),
      expect.objectContaining({ name: 'remote', trigger: 'manual', layers: ['remote'], keys: 1 }),
      expect.objectContaining({ name: 'polled', trigger: 'poll', layers: [], keys: 0 }),
    ])
    expect(inspection.sources[0]).not.toHaveProperty('lastError')
  })

  it('redacts the snapshot it reports', async () => {
    const store = await loaded()

    expect(store.inspect().snapshot).toEqual({
      server: { host: '0.0.0.0', port: 8080 },
      db: { url: 'u', password: REDACTED },
    })
    expect(JSON.stringify(store.inspect())).not.toContain('from-env')
  })
})
