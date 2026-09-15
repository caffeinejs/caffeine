import { describe, expect, it } from 'vitest'

import type { ConfigProvider, PropertySource, ResolutionContext } from '../config.js'
import { ConfigEngine } from '../engine.js'
import { ConfigSources } from '../sources.js'

const ctx: ResolutionContext = { profiles: ['default'] }

function makeProvider(id: string, sources: PropertySource[], fail = false): ConfigProvider {
  return {
    id,
    load: fail ? () => Promise.reject(new Error(`${id} failed`)) : () => Promise.resolve(sources),
  }
}

function makeSource(name: string, data: Record<string, unknown>): PropertySource {
  const entries = new Map(Object.entries(data).map(([k, v]) => [k, { key: k, value: v as never, origin: name }]))
  return { name, entries }
}

describe('ConfigEngine', () => {
  it('the first provider in resolution order wins over a later one', async () => {
    // `ConfigSources` resolves most-recently-registered first, so `p1` is added last.
    const engine = new ConfigEngine({
      sources: new ConfigSources()
        .add(makeProvider('p2', [makeSource('second', { 'db.host': 'second-host' })]))
        .add(makeProvider('p1', [makeSource('first', { 'db.host': 'first-host' })])),
    })

    const snapshot = await engine.resolve(ctx)
    expect(snapshot.values.get('db.host')?.value).toBe('first-host')
  })

  it('first-write-wins: a key is not overwritten by an earlier-registered source', async () => {
    const engine = new ConfigEngine({
      sources: new ConfigSources()
        .add(makeProvider('file', [makeSource('file', { 'app.port': 3000 })]))
        .add(makeProvider('env', [makeSource('env', { 'app.port': 9000 })])),
    })

    const snapshot = await engine.resolve(ctx)
    expect(snapshot.values.get('app.port')?.value).toBe(9000)
  })

  it('throws ERR_CONFIG_PROVIDER when failFast (default) and provider fails', async () => {
    const engine = new ConfigEngine({
      sources: ConfigSources.of(makeProvider('bad', [], true)),
    })

    await expect(engine.resolve(ctx)).rejects.toMatchObject({ name: 'ErrConfig', code: 'ERR_CONFIG_PROVIDER' })
  })

  it('skips failing provider when failFast is false', async () => {
    const engine = new ConfigEngine({
      failFast: false,
      sources: ConfigSources.of(
        makeProvider('bad', [], true),
        makeProvider('ok', [makeSource('ok', { key: 'value' })]),
      ),
    })

    const snapshot = await engine.resolve(ctx)
    expect(snapshot.values.get('key')?.value).toBe('value')
  })

  it('tracks origin metadata', async () => {
    const engine = new ConfigEngine({
      sources: ConfigSources.of(makeProvider('env', [makeSource('env:APP_HOST', { 'app.host': 'localhost' })])),
    })

    const snapshot = await engine.resolve(ctx)
    expect(snapshot.values.get('app.host')?.origin).toBe('env:APP_HOST')
  })

  it('within a provider, first returned source wins', async () => {
    const engine = new ConfigEngine({
      sources: ConfigSources.of(
        makeProvider('p1', [makeSource('first', { key: 'from-first' }), makeSource('second', { key: 'from-second' })]),
      ),
    })

    const snapshot = await engine.resolve(ctx)
    expect(snapshot.values.get('key')?.value).toBe('from-first')
  })
})
