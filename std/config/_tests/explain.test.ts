import { describe, expect, it } from 'vitest'

import { $t } from '../../schema/t.js'
import { loadConfig } from '../load.js'
import { passthroughConfigSchema } from '../schema.js'
import { ArgsConfigSource } from '../sources/args_source.js'
import type { ConfigDefinition, ConfigLayer, ConfigSchema, ConfigSource } from '../types.js'

function definition<T>(sources: ConfigSource[], schema: ConfigSchema<T>): ConfigDefinition<T> {
  return { schema, key: undefined, storeKey: undefined, sources, loadTimeoutMs: 30_000 }
}

function source(name: string, ...layers: ConfigLayer[]): ConfigSource {
  return { name, load: () => layers }
}

const schema = $t.Object({
  server: $t.Object({ host: $t.String({ default: '0.0.0.0' }), port: $t.Number() }, { default: {} }),
  db: $t.Object({ url: $t.String(), password: $t.String() }),
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

  // What explain() returns is for whoever asked: nothing in it is hidden, so a caller that prints it prints secrets.
  it('explains a branch as the part of it each layer holds, every value as it is', async () => {
    const store = await loaded()

    expect(store.explain('db')).toEqual({
      path: 'db',
      value: { url: 'u', password: 'from-env' },
      layers: [
        { layer: 'env', origin: 'env', value: { password: 'from-env' } },
        { layer: 'file:app.json', origin: 'file:app.json', value: { url: 'u', password: 'from-file' } },
      ],
    })
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

  // `--servers[0].host=h` sets a path; asking why it has its value, spelled the same way, must find it.
  it('reads the bracket form of a path as the command line does', async () => {
    const argv = ['--servers[0].host=h']
    const store = await loadConfig(definition([new ArgsConfigSource({ argv })], passthroughConfigSchema))

    expect(store.explain('servers[0].host')).toMatchObject({
      path: 'servers.0.host',
      value: 'h',
      layers: [{ layer: 'args', origin: 'args:--servers[0].host=h', value: 'h' }],
    })
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

  it('reports the current snapshot, every value as it is', async () => {
    const store = await loaded()

    expect(store.inspect().snapshot).toBe(store.current)
    expect(store.inspect().snapshot).toEqual({
      server: { host: '0.0.0.0', port: 8080 },
      db: { url: 'u', password: 'from-env' },
    })
  })
})
